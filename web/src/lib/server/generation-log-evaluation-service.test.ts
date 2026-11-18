import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeJsonDataFile } from "./data-adapter";
import { getGenerationLogEvaluation, listGenerationLogEvaluations } from "./generation-log-evaluation-store";
import { evaluateGenerationLog, parseGenerationLogEvaluationInput } from "./generation-log-evaluation-service";

const auth = vi.hoisted(() => ({ settings: vi.fn(), refund: vi.fn() }));
vi.mock("@/lib/auth/store", () => ({ getAuthSettings: auth.settings, refundUserPoints: auth.refund }));

let folder = "";
let server: Server;
let origin = "";
let requests: Array<{ body: unknown; cookie?: string; model?: string }>;
let report: unknown;
const actor = { id: "admin", username: "reviewer", displayName: "复盘管理员" };
const action = { kind: "ai_review", requestId: "11111111-1111-4111-8111-111111111111" } as const;
beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "generation-log-review-"));
    vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
    vi.stubEnv("VOZEB_PRO_DATA_DIR", folder);
    auth.refund.mockReset().mockResolvedValue({});
    requests = [];
    report = { outcome: "insufficient_evidence", summary: "未取得用户原话和反馈，不能判断需求满足程度。", limitations: ["原话缺失"], issues: [] };
    server = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        requests.push({ body: JSON.parse(Buffer.concat(chunks).toString("utf8")), cookie: req.headers.cookie, model: req.headers["x-vozeb-pro-logical-model"] as string });
        res.writeHead(200, { "content-type": "application/json", "x-vozeb-pro-points-cost": "0", "x-vozeb-pro-points-record-id": "zero-charge" }).end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(report) } }] }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture port unavailable");
    origin = `http://127.0.0.1:${address.port}`;
    auth.settings.mockReset().mockResolvedValue({
        defaultModels: { textModel: "review-text" },
        logicalModels: [],
        systemChannels: [{ id: "fixture", name: "Fixture", apiKey: "fixture", baseUrl: origin, apiFormat: "openai", models: ["review-text"], enabled: true, advancedConfig: { protocol: "newapi", textModel: "review-text" } }],
    });
    await writeJsonDataFile("generation-logs.json", {
        version: 1,
        logs: [
            {
                id: "log",
                userId: "owner",
                username: "owner",
                displayName: "Owner",
                kind: "image",
                source: "agent",
                status: "success",
                prompt: "compiled",
                model: "image",
                title: "Result",
                summary: "saved",
                durationMs: 1000,
                count: 1,
                successCount: 1,
                failCount: 0,
                assets: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            },
        ],
    });
});
afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(folder, { recursive: true, force: true });
    vi.unstubAllEnvs();
});

describe("manual generation log review", () => {
    it("archives an immutable review, charges the triggering admin, and reuses concurrent or repeated requests", async () => {
        const input = { logId: "log", actor, action, origin, cookie: "session=admin" };
        await Promise.all([evaluateGenerationLog(input), evaluateGenerationLog(input)]);
        const completed = await evaluateGenerationLog(input);
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({ cookie: "session=admin", model: "review-text" });
        expect(completed).toMatchObject({
            status: "completed",
            userId: "owner",
            actorId: "admin",
            review: { mode: "text_metadata", model: { upstreamModel: "review-text" }, pointsCost: 0, pointsRecordId: "zero-charge", report: { outcome: "insufficient_evidence" } },
        });
        expect(await getGenerationLogEvaluation(completed.id)).toEqual(completed);
        await expect(evaluateGenerationLog({ ...input, logId: "different" })).rejects.toMatchObject({ status: 409 });
    });
    it("preserves invalid output as a failed review and refunds a zero point usage to the same admin", async () => {
        report = { outcome: "issues_found", summary: "杜撰", limitations: [], issues: [{ category: "wrong", message: "test", evidenceIds: ["invented"], recommendation: "test" }] };
        const saved = await evaluateGenerationLog({ logId: "log", actor, action, origin, cookie: "session=admin" });
        expect(saved).toMatchObject({ status: "failed", review: { pointsCost: 0, pointsRecordId: "zero-charge", refunded: true } });
        expect(auth.refund).toHaveBeenCalledWith("admin", "review-text", 0, "text", 1, undefined, "zero-charge");
        expect(await listGenerationLogEvaluations("log")).toEqual([saved]);
        expect(requests).toHaveLength(1);
    });
    it("saves user words as attributed transcribed feedback without a model call", async () => {
        const input = parseGenerationLogEvaluationInput({ requestId: action.requestId, kind: "feedback", sentiment: "unsatisfied", message: "桌腿数量不对" });
        const saved = await evaluateGenerationLog({ logId: "log", actor, action: input, origin, cookie: "session=admin" });
        expect(saved).toMatchObject({ kind: "feedback", actorId: "admin", feedback: { message: "桌腿数量不对", sentiment: "unsatisfied", source: "admin_transcribed" } });
        expect(requests).toHaveLength(0);
    });
});
