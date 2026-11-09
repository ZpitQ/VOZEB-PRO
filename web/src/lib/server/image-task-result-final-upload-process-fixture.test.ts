import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";

const serialized = process.env.VOZEB_PRO_FINAL_UPLOAD_ACTOR_INPUT;

(serialized ? it : it.skip)(
    "uploads one real final through an independent pool1 process",
    async () => {
        assert.ok(serialized);
        if (
            process.env.VOZEB_PRO_RUN_ECOMMERCE_POSTGRES_INTEGRATION !== "1" ||
            process.env.VOZEB_PRO_ECOMMERCE_ISOLATED_DATABASE !== "1" ||
            process.env.VOZEB_PRO_DATABASE_PROVIDER !== "postgres" ||
            process.env.VOZEB_PRO_DATABASE_POOL_MAX !== "1" ||
            !process.env.DATABASE_URL
        )
            throw new Error("Explicit isolated PostgreSQL upload actor with startup pool maximum one is required");
        const input: unknown = JSON.parse(serialized);
        assert.ok(input !== null && typeof input === "object");
        assert.ok("origin" in input && typeof input.origin === "string");
        assert.ok("key" in input && typeof input.key === "string");
        assert.ok("userId" in input && typeof input.userId === "string");
        assert.ok("taskId" in input && typeof input.taskId === "string");
        assert.ok("workerId" in input && typeof input.workerId === "string");
        assert.ok("executionId" in input && typeof input.executionId === "string");
        assert.ok("resultId" in input && typeof input.resultId === "string");
        assert.ok("filePath" in input && typeof input.filePath === "string");
        assert.ok("receiptPath" in input && typeof input.receiptPath === "string");
        const database = await import("./database");
        const service = await import("./image-processing-service");
        const tasks = await import("./generation-task-store");
        await database.ensurePostgresSchema();
        const task = await tasks.getStoredGenerationTaskRecord("image_processing", input.taskId);
        expect(task?.userId).toBe(input.userId);
        expect(task?.workerId).toBe(input.workerId);
        expect(task?.payload.executionId).toBe(input.executionId);
        const bytes = await readFile(input.filePath);
        const backend = await database.postgresQuery<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const pid = backend.rows[0]?.pid;
        assert.ok(pid);
        const ready = await fetch(input.origin + "/final-upload-actor/" + input.key + "?pid=" + String(pid), { method: "POST" });
        expect(ready.status).toBe(200);
        const stream = new Response(new Uint8Array(bytes)).body;
        assert.ok(stream);
        const receipt = await service.writeImageProcessingOutput(input.taskId, "final", { workerId: input.workerId, executionId: input.executionId }, { stream, mimeType: "image/png", resultId: input.resultId });
        await writeFile(input.receiptPath, JSON.stringify(receipt), { encoding: "utf8", flag: "wx" });
    },
    30_000,
);
