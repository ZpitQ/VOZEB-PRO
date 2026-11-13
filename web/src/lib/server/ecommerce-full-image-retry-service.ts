import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { AGENT_RUN_TTL_MS, type AgentRun } from "./agent-run-store";
import { mutateCreativeRun } from "./creative-runtime-store";
import { ecommerceSceneSelectionTask } from "./ecommerce-generation-snapshot";
import { hasOnlyCompletedEcommerceReferencePrepares } from "./image-processing-service";

export async function retryEcommerceSceneSelectionAsFullImage(run: AgentRun) {
    return mutateCreativeRun<AgentRun>(
        run.id,
        AGENT_RUN_TTL_MS,
        (current, context) => {
            const snapshot = current.ecommerceSnapshot;
            if (
                current.userId !== run.userId ||
                current.conversationId !== run.conversationId ||
                current.surface !== "chat" ||
                !ecommerceSceneSelectionTask(current) ||
                !snapshot?.plan ||
                !isDeepStrictEqual(current.tasks, run.tasks) ||
                !isDeepStrictEqual(snapshot, run.ecommerceSnapshot) ||
                !hasOnlyCompletedEcommerceReferencePrepares(current, context.persistedChildren)
            )
                return null;
            return {
                run: {
                    ...current,
                    status: "planning",
                    planningRequestId: `${current.id}:planning:${randomUUID()}`,
                    executionId: undefined,
                    tasks: [],
                    ecommerceSnapshot: { ...snapshot, plan: undefined, compilerVersion: undefined, fallback: undefined, qualityCheck: undefined, technicalCheck: undefined },
                    ecommerceGenerations: undefined,
                    foundation: undefined,
                    projectHandoff: undefined,
                    projectHandoffEmitted: undefined,
                    review: undefined,
                    reviewed: false,
                    assetIds: [],
                    failure: undefined,
                    failureStage: undefined,
                    candidateFailures: undefined,
                },
                event: { type: "run.retry.requested", data: { previousPlanVersion: snapshot.plan.planVersion, strategy: "full_image" } },
                assistant: { status: "running", content: "正在重新分析并执行这次请求…" },
            };
        },
        ["paused"],
        undefined,
        { resumeWithChildren: true },
    );
}
