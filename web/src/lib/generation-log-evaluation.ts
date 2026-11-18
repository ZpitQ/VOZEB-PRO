export type GenerationLogEvidence = { id: string; label: string; facts: unknown };

export type GenerationLogReviewReport = {
    outcome: "no_issue_observed" | "issues_found" | "insufficient_evidence";
    summary: string;
    limitations: string[];
    issues: { category: string; message: string; evidenceIds: string[]; recommendation: string }[];
};

export type GenerationLogEvaluation = {
    id: string;
    logId: string;
    userId: string;
    actorId: string;
    actorName: string;
    fingerprint: string;
    createdAt: string;
    updatedAt: string;
} & (
    | { kind: "feedback"; status: "completed"; feedback: { sentiment: "satisfied" | "partly_satisfied" | "unsatisfied"; message: string; source: "admin_transcribed" } }
    | {
          kind: "ai_review";
          status: "pending" | "completed" | "failed";
          review: {
              ruleVersion: string;
              mode: "text_metadata";
              model: { logicalModelId: string; channelId: string; upstreamModel: string };
              factsDigest: string;
              evidence: GenerationLogEvidence[];
              report?: GenerationLogReviewReport;
              error?: string;
              pointsCost?: number;
              pointsRecordId?: string;
              refunded?: boolean;
              completedAt?: string;
          };
      }
);

export type GenerationLogEvaluationInput = { requestId: string } & ({ kind: "feedback"; sentiment: "satisfied" | "partly_satisfied" | "unsatisfied"; message: string } | { kind: "ai_review" });
