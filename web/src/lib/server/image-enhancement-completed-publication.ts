import { isDeepStrictEqual } from "node:util";
import type { AgentRun } from "./agent-run-store";
import { readRuntimeFile } from "./creative-runtime-repository";
import type { ImageEnhancementJob, StoredEnhancementArtifact } from "./database/image-enhancement-job-repository";
import { getStoredGenerationTask } from "./generation-task-store";
import { writeEnhancementArtifactFile } from "./generation-log-repository";
import { assertEnhancementProcessingManifest } from "./image-enhancement-processing";
import { readVerifiedEnhancementArtifact, readVerifiedEnhancementMedia } from "./image-enhancement-processing-media";
import {
    assertEnhancementRelation,
    closedEnhancementOutcome,
    enhancementRelationLocator,
    enhancementRelationStorageKeys,
    EnhancementProcessingConflict,
    mutateEnhancementRelation,
    readEnhancementProcessingTask,
    type ClosedEnhancementResult,
    type EnhancementRelationState,
} from "./image-enhancement-processing-store";
import { commitImageEnhancementPublication, ImageEnhancementPublicationError } from "./image-enhancement-publication";
import type { ImageTask } from "./image-task-store";
import { getLocalMediaRegistrations } from "./local-media-registry";
import { createDatedMediaPath } from "./local-media-storage";

function conflict(message: string): never {
    throw new EnhancementProcessingConflict(message);
}

function completedPublication(state: EnhancementRelationState, lease: ImageEnhancementJob) {
    const { child, checkpoint } = assertEnhancementRelation(state);
    const outcome = closedEnhancementOutcome(child);
    if (
        state.parent.id !== lease.id ||
        state.parent.userId !== lease.userId ||
        state.parent.phase !== "publish" ||
        outcome?.status !== "completed" ||
        !isDeepStrictEqual(outcome, checkpoint.outcome) ||
        !isDeepStrictEqual(outcome, lease.publicationProcessing?.outcome)
    )
        conflict("Enhancement publication requires the matching closed CPU outcome");
    const receipt = child.resultPayload as ClosedEnhancementResult;
    if (!receipt.metrics) conflict("Enhancement closed CPU metrics are missing");
    assertEnhancementProcessingManifest(child, { workerId: receipt.workerId, executionId: outcome.executionId, manifest: outcome.manifest, metrics: receipt.metrics });
    return { child, checkpoint, outcome, result: outcome.manifest.enhancement!, artifact: outcome.manifest.artifacts[0] };
}

function permanentStorageKey(staged: StoredEnhancementArtifact | undefined, format: "png" | "jpeg") {
    return staged
        ? new URL(staged.url, "http://enhancement-publication.local").pathname.slice("/api/generation-log-assets/".length).split("/").map(decodeURIComponent).join("/")
        : createDatedMediaPath("permanent", "image", format === "jpeg" ? "jpg" : "png");
}

export async function publishCompletedEnhancement(lease: ImageEnhancementJob) {
    const initial = await readEnhancementProcessingTask(lease.publicationProcessing!.jobId);
    if (!initial) conflict("Enhancement completed CPU child is missing");
    const locator = enhancementRelationLocator(initial);
    const fence = { parentLease: { token: lease.leaseToken!, now: Date.now() } };
    const prepared = await mutateEnhancementRelation(
        locator,
        enhancementRelationStorageKeys(initial),
        (state) => {
            const closed = completedPublication(state, lease);
            const promotion = closed.checkpoint.promotion ?? {
                aiStorageKey: permanentStorageKey(state.parent.staged?.ai, closed.result.ai.format),
                deliveredStorageKey: permanentStorageKey(state.parent.staged?.delivered, closed.artifact.mimeType === "image/jpeg" ? "jpeg" : "png"),
            };
            return {
                parent: { ...state.parent, publicationProcessing: { ...closed.checkpoint, promotion }, updatedAt: state.now },
                result: {
                    ...closed,
                    promotion,
                    task: state.image!.payload as ImageTask,
                    aiRegistration: state.registrations.find((registration) => registration.storageKey === closed.checkpoint.rawAi.source.storageKey)!,
                },
                requireOriginal: true,
            };
        },
        fence,
    );
    const ai = await readVerifiedEnhancementMedia(prepared.aiRegistration, { ...prepared.result.ai, bytes: prepared.result.ai.byteLength, mimeType: "image/" + prepared.result.ai.format }, prepared.child.payload.options.budgets.ai);
    try {
        const delivered = await readVerifiedEnhancementArtifact(prepared.child, prepared.artifact);
        try {
            const save = async (role: "ai" | "delivered", filePath: string, artifact: Omit<StoredEnhancementArtifact, "url">, storageKey: string): Promise<StoredEnhancementArtifact> => {
                // Keep byte and metadata verification in the existing original-file writer; no Web pixel processing.
                const saved = await writeEnhancementArtifactFile(filePath, artifact, {
                    storageKey,
                    ownerUserId: lease.userId,
                    source: prepared.task.source,
                    conversationId: prepared.task.conversationId,
                    taskId: lease.id,
                    originalName: `${role === "ai" ? "完整AI增强" : "AI高清增强"}.${artifact.format === "jpeg" ? "jpg" : "png"}`,
                }).catch((cause) => {
                    throw new ImageEnhancementPublicationError("output_storage_invalid", { cause });
                });
                return { ...artifact, url: saved.serverUrl! };
            };
            const storedAi = await save("ai", ai.filePath, prepared.result.ai, prepared.promotion.aiStorageKey);
            const storedDelivery = await save(
                "delivered",
                delivered.filePath,
                {
                    sha256: prepared.artifact.sha256,
                    byteLength: prepared.artifact.bytes,
                    width: prepared.artifact.width,
                    height: prepared.artifact.height,
                    format: prepared.artifact.mimeType === "image/jpeg" ? "jpeg" : "png",
                },
                prepared.promotion.deliveredStorageKey,
            );
            const permanentKeys = [prepared.promotion.aiStorageKey, prepared.promotion.deliveredStorageKey];
            const permanentRegistrations = await getLocalMediaRegistrations(permanentKeys, { ownerUserId: lease.userId });
            const sourceRun = prepared.task.runId ? await getStoredGenerationTask<AgentRun>("agent", prepared.task.runId) : null;
            return await mutateEnhancementRelation(
                locator,
                [...enhancementRelationStorageKeys(initial), ...permanentKeys],
                async (state, executor) => {
                    const closed = completedPublication(state, lease);
                    if (!isDeepStrictEqual(state.image!.payload, prepared.task) || !isDeepStrictEqual(closed.child.payload, prepared.child.payload) || !isDeepStrictEqual(closed.checkpoint.promotion, prepared.promotion))
                        conflict("Enhancement promotion identity changed");
                    for (const registration of [prepared.aiRegistration, delivered.registration, ...permanentRegistrations]) {
                        if (
                            !isDeepStrictEqual(
                                state.registrations.find((value) => value.storageKey === registration.storageKey),
                                registration,
                            )
                        )
                            conflict("Enhancement publication media registration changed");
                    }
                    for (const [storageKey, artifact] of [
                        [prepared.promotion.aiStorageKey, storedAi],
                        [prepared.promotion.deliveredStorageKey, storedDelivery],
                    ] as const) {
                        const registration = state.registrations.find((value) => value.storageKey === storageKey);
                        if (
                            !registration ||
                            registration.ownerUserId !== state.parent.userId ||
                            registration.scope !== "generation" ||
                            registration.storageClass !== "permanent" ||
                            registration.type !== "image" ||
                            registration.taskId !== state.parent.id ||
                            registration.source !== prepared.task.source ||
                            registration.conversationId !== prepared.task.conversationId ||
                            registration.mimeType !== "image/" + artifact.format ||
                            registration.bytes !== artifact.byteLength ||
                            registration.expiresAt !== undefined
                        )
                            conflict("Enhancement permanent media registration changed");
                    }
                    const events = [...state.parent.events];
                    if (!events.some((event) => event.stage === "storage_verified" && event.attempt === state.parent.attempt)) events.push({ stage: "storage_verified", at: state.now, attempt: state.parent.attempt });
                    if (closed.result.protection && !events.some((event) => event.stage === "protection_verified" && event.attempt === state.parent.attempt)) events.push({ stage: "protection_verified", at: state.now, attempt: state.parent.attempt });
                    const parent = await commitImageEnhancementPublication(
                        { ...state.parent, events },
                        state.image!.payload as ImageTask,
                        { ai: storedAi, delivered: storedDelivery, protection: closed.result.protection },
                        sourceRun,
                        executor,
                        executor ? undefined : await readRuntimeFile(),
                    );
                    if (closed.result.deliveryEncodingMs !== undefined) parent.timings = { ...parent.timings, deliveryEncodingMs: closed.result.deliveryEncodingMs };
                    return { parent, result: parent, requireOriginal: true };
                },
                fence,
            );
        } finally {
            await delivered.dispose();
        }
    } finally {
        await ai.dispose();
    }
}
