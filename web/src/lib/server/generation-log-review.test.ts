import { describe, expect, it } from "vitest";
import { buildGenerationLogEvidence, parseGenerationLogReview } from "./generation-log-review";
import type { StoredGenerationLog } from "./generation-log-types";

const log: StoredGenerationLog = {
    id: "log",
    userId: "owner",
    username: "user",
    displayName: "User",
    kind: "image",
    source: "agent",
    status: "success",
    title: "Result",
    prompt: "compiled prompt",
    model: "image",
    summary: "saved",
    durationMs: 1200,
    count: 1,
    successCount: 1,
    failCount: 0,
    assets: [{ type: "image", url: "https://media.invalid/file?secret=private", width: 1024, height: 768, resultId: "result" }],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:02Z",
};

describe("generation log retrospective evidence", () => {
    it("preserves unknown demand and feedback without leaking media credentials or inventing quality", () => {
        const evidence = buildGenerationLogEvidence(log, []);
        expect(evidence.find((item) => item.id === "request")?.facts).toMatchObject({ userPrompt: null });
        expect(evidence.find((item) => item.id === "feedback")?.facts).toEqual([]);
        expect(JSON.stringify(evidence)).not.toContain("secret");
        expect(evidence.find((item) => item.id === "result:1")?.facts).toMatchObject({ resultId: "result", width: 1024, height: 768 });
    });
    it("keeps check conclusions without copying signed media locations into a review", () => {
        const evidence = buildGenerationLogEvidence(
            {
                ...log,
                ecommerceTrace: {
                    version: "ecommerce-generation-trace.v1",
                    runId: "run",
                    agentTaskId: "task",
                    imageTaskIds: [],
                    finalStatus: "completed",
                    recordedAt: 1000,
                    stages: [{ key: "image_generation", status: "completed", output: { technicalCheck: { status: "passed", canvasEvidence: [{ nativeUrl: "https://media.invalid?secret=private" }] } } }],
                },
            },
            [],
        );
        expect(evidence.find((item) => item.id === "stage:image_generation")?.facts).toMatchObject({ technicalCheck: { status: "passed" } });
        expect(JSON.stringify(evidence)).not.toContain("secret");
    });
    it("requires actual evidence citations for a saved recommendation", () => {
        const report = { outcome: "issues_found", summary: "缺少需求记录", limitations: ["未查看图片"], issues: [{ category: "recording", message: "原话未知", evidenceIds: ["request"], recommendation: "保留原话" }] };
        expect(parseGenerationLogReview(JSON.stringify(report), buildGenerationLogEvidence(log, []))).toEqual(report);
        expect(() => parseGenerationLogReview(JSON.stringify({ ...report, issues: [{ ...report.issues[0], evidenceIds: ["invented"] }] }), buildGenerationLogEvidence(log, []))).toThrow("证据");
    });
    it("rejects a contradictory pass and issues or malformed model output", () => {
        const report = { outcome: "no_issue_observed", summary: "正常", limitations: [], issues: [{ category: "timing", message: "慢", evidenceIds: ["request"], recommendation: "检查" }] };
        expect(() => parseGenerationLogReview(JSON.stringify(report), buildGenerationLogEvidence(log, []))).toThrow();
        expect(() => parseGenerationLogReview("{}", buildGenerationLogEvidence(log, []))).toThrow();
    });
});
