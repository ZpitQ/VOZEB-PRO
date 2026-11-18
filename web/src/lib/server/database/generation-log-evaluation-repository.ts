import type { GenerationLogEvaluation } from "@/lib/generation-log-evaluation";
import type { QueryExecutor } from "./postgres";

export type GenerationLogEvaluationDatabase = { version: 1; evaluations: GenerationLogEvaluation[] };

export class GenerationLogEvaluationStoreError extends Error {
    constructor(
        message: string,
        public status: number,
    ) {
        super(message);
    }
}

export function assertGenerationLogEvaluationIdentity(existing: GenerationLogEvaluation, incoming: GenerationLogEvaluation) {
    if (existing.logId !== incoming.logId || existing.userId !== incoming.userId || existing.actorId !== incoming.actorId || existing.fingerprint !== incoming.fingerprint || existing.kind !== incoming.kind)
        throw new GenerationLogEvaluationStoreError("该请求标识已用于其他评价", 409);
}

export class GenerationLogEvaluationRepository {
    constructor(private readonly executor: QueryExecutor) {}

    async getById(id: string, lock = false) {
        const result = await this.executor.query<{ payload: GenerationLogEvaluation }>(`SELECT payload FROM generation_log_evaluations WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id]);
        return result.rows[0]?.payload || null;
    }

    async listByLogId(logId: string) {
        const result = await this.executor.query<{ payload: GenerationLogEvaluation }>("SELECT payload FROM generation_log_evaluations WHERE log_id = $1 ORDER BY created_at DESC, id", [logId]);
        return result.rows.map((row) => row.payload);
    }

    async claim(record: GenerationLogEvaluation) {
        const saved = await this.getById(record.id);
        if (saved) assertGenerationLogEvaluationIdentity(saved, record);
        await this.lockParent(record);
        const result = await this.executor.query<{ payload: GenerationLogEvaluation }>(
            `INSERT INTO generation_log_evaluations (id, log_id, user_id, actor_id, payload, created_at)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6) ON CONFLICT (id) DO NOTHING RETURNING payload`,
            [record.id, record.logId, record.userId, record.actorId, JSON.stringify(record), record.createdAt],
        );
        if (result.rows[0]) return { record: result.rows[0].payload, created: true };
        const existing = await this.getById(record.id, true);
        if (!existing) throw new Error("评价请求未能保存");
        assertGenerationLogEvaluationIdentity(existing, record);
        return { record: existing, created: false };
    }

    async finish(record: GenerationLogEvaluation) {
        await this.lockParent(record);
        const existing = await this.getById(record.id, true);
        if (!existing) throw new GenerationLogEvaluationStoreError("评价记录不存在", 404);
        assertGenerationLogEvaluationIdentity(existing, record);
        if (existing.status !== "pending") return existing;
        if (record.status === "pending") throw new GenerationLogEvaluationStoreError("评价尚未结束", 409);
        const result = await this.executor.query<{ payload: GenerationLogEvaluation }>("UPDATE generation_log_evaluations SET payload = $2::jsonb WHERE id = $1 AND payload->>'status' = 'pending' RETURNING payload", [record.id, JSON.stringify(record)]);
        return result.rows[0].payload;
    }

    async readBackup(): Promise<GenerationLogEvaluationDatabase> {
        const result = await this.executor.query<{ payload: GenerationLogEvaluation }>("SELECT payload FROM generation_log_evaluations ORDER BY created_at DESC, id");
        return { version: 1, evaluations: result.rows.map((row) => row.payload) };
    }

    async restoreBackup(db: GenerationLogEvaluationDatabase) {
        for (const record of db.evaluations) {
            await this.lockParent(record);
            const existing = await this.getById(record.id, true);
            if (existing) assertGenerationLogEvaluationIdentity(existing, record);
            await this.executor.query(
                `INSERT INTO generation_log_evaluations (id, log_id, user_id, actor_id, payload, created_at)
                 VALUES ($1, $2, $3, $4, $5::jsonb, $6)
                 ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload`,
                [record.id, record.logId, record.userId, record.actorId, JSON.stringify(record), record.createdAt],
            );
        }
    }

    private async lockParent(record: GenerationLogEvaluation) {
        const result = await this.executor.query<{ user_id: string }>("SELECT user_id FROM generation_logs WHERE id = $1 FOR UPDATE", [record.logId]);
        if (result.rows[0]?.user_id !== record.userId) throw new GenerationLogEvaluationStoreError("生成日志不存在或归属不符", 404);
    }
}
