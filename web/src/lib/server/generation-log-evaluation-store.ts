import type { GenerationLogEvaluation } from "@/lib/generation-log-evaluation";
import { createPostgresRepositories, ensurePostgresSchema, isPostgresDatabaseEnabled, withPostgresTransaction, type QueryExecutor } from "@/lib/server/database";
import { assertGenerationLogEvaluationIdentity, GenerationLogEvaluationStoreError, type GenerationLogEvaluationDatabase } from "@/lib/server/database/generation-log-evaluation-repository";
import { withGenerationLogEvaluationFiles, writeGenerationLogEvaluationFile } from "@/lib/server/generation-log-evaluation-file";

export { GenerationLogEvaluationStoreError };
export type { GenerationLogEvaluationDatabase };

export async function getGenerationLogEvaluation(id: string) {
    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        return createPostgresRepositories().generationLogEvaluations.getById(id);
    }
    return withGenerationLogEvaluationFiles(async (_logs, db) => db.evaluations.find((record) => record.id === id) || null);
}

export async function listGenerationLogEvaluations(logId: string) {
    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        return createPostgresRepositories().generationLogEvaluations.listByLogId(logId);
    }
    return withGenerationLogEvaluationFiles(async (_logs, db) => db.evaluations.filter((record) => record.logId === logId).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)));
}

export async function claimGenerationLogEvaluation(record: GenerationLogEvaluation) {
    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        return withPostgresTransaction((client) => createPostgresRepositories(client).generationLogEvaluations.claim(record));
    }
    return withGenerationLogEvaluationFiles(async (logs, db) => {
        const existing = db.evaluations.find((item) => item.id === record.id);
        if (existing) assertGenerationLogEvaluationIdentity(existing, record);
        if (!logs.logs.some((log) => log.id === record.logId && log.userId === record.userId)) throw new GenerationLogEvaluationStoreError("生成日志不存在或归属不符", 404);
        if (existing) {
            return { record: existing, created: false };
        }
        await writeGenerationLogEvaluationFile({ ...db, evaluations: [...db.evaluations, record] });
        return { record, created: true };
    });
}

export async function finishGenerationLogEvaluation(record: GenerationLogEvaluation) {
    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        return withPostgresTransaction((client) => createPostgresRepositories(client).generationLogEvaluations.finish(record));
    }
    return withGenerationLogEvaluationFiles(async (logs, db) => {
        if (!logs.logs.some((log) => log.id === record.logId && log.userId === record.userId)) throw new GenerationLogEvaluationStoreError("生成日志不存在或归属不符", 404);
        const existing = db.evaluations.find((item) => item.id === record.id);
        if (!existing) throw new GenerationLogEvaluationStoreError("评价记录不存在", 404);
        assertGenerationLogEvaluationIdentity(existing, record);
        if (existing.status !== "pending") return existing;
        if (record.status === "pending") throw new GenerationLogEvaluationStoreError("评价尚未结束", 409);
        await writeGenerationLogEvaluationFile({ ...db, evaluations: db.evaluations.map((item) => (item.id === record.id ? record : item)) });
        return record;
    });
}

/** Complete snapshots are reserved for the explicit administrator backup transaction. */
export function readPostgresGenerationLogEvaluationBackup(executor: QueryExecutor) {
    return createPostgresRepositories(executor).generationLogEvaluations.readBackup();
}

export function restorePostgresGenerationLogEvaluationBackup(db: GenerationLogEvaluationDatabase, executor: QueryExecutor) {
    return createPostgresRepositories(executor).generationLogEvaluations.restoreBackup(db);
}
