import { readJsonDataFile, withJsonDataFileLock, writeJsonDataFile } from "@/lib/server/data-adapter";
import { readGenerationLogDb, writeGenerationLogDb } from "@/lib/server/generation-log-repository";
import type { GenerationLogDatabase, StoredGenerationLog } from "@/lib/server/generation-log-types";
import type { GenerationLogEvaluationDatabase } from "@/lib/server/database/generation-log-evaluation-repository";

const FILE_NAME = "generation-log-evaluations.json";

export function withGenerationLogEvaluationFiles<T>(callback: (logs: GenerationLogDatabase, evaluations: GenerationLogEvaluationDatabase) => Promise<T>) {
    // Every claim, deletion and backup uses the parent log lock before the evaluation lock.
    return withJsonDataFileLock("generation-logs.json", () => withJsonDataFileLock(FILE_NAME, async () => callback(await readGenerationLogDb(), await readJsonDataFile<GenerationLogEvaluationDatabase>(FILE_NAME, { version: 1, evaluations: [] }))));
}

export function writeGenerationLogEvaluationFile(db: GenerationLogEvaluationDatabase) {
    return writeJsonDataFile(FILE_NAME, db);
}

export function deleteGenerationLogFileRecords(matches: (log: StoredGenerationLog) => boolean) {
    return withGenerationLogEvaluationFiles(async (db, evaluations) => {
        const removed = db.logs.filter(matches);
        if (!removed.length) return removed;
        const ids = new Set(removed.map((log) => log.id));
        const nextEvaluations = { ...evaluations, evaluations: evaluations.evaluations.filter((record) => !ids.has(record.logId)) };
        await writeGenerationLogEvaluationFile(nextEvaluations);
        try {
            await writeGenerationLogDb({ ...db, logs: db.logs.filter((log) => !ids.has(log.id)) });
        } catch (error) {
            try {
                await writeGenerationLogEvaluationFile(evaluations);
            } catch (rollbackError) {
                throw new AggregateError([error, rollbackError], "生成日志删除失败，且评价文件未能回滚");
            }
            throw error;
        }
        return removed;
    });
}
