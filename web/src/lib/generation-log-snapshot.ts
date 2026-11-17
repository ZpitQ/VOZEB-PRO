export type GenerationLogSnapshotParameters = {
    model?: string;
    size?: string;
    quality?: string;
    count?: string;
    resolution?: string;
    seconds?: string;
    generateAudio?: string;
    watermark?: string;
};

export type GenerationLogReferenceSnapshot = {
    id: string;
    kind: "image" | "video" | "audio";
    name: string;
    mimeType: string;
    url?: string;
    remoteUrl?: string;
    serverUrl?: string;
    storageKey?: string;
    bytes?: number;
    width?: number;
    height?: number;
    durationMs?: number;
    alias?: string;
    purposes?: string[];
    providerIndex?: number;
    assetVersion?: string;
    sha256?: string;
    sourceRunId?: string;
    sourceTaskId?: string;
    parentAssetId?: string;
    submittedUrl?: string;
};

export type GenerationLogAttemptSnapshot = {
    attemptNo: number;
    channelId?: string;
    model: string;
    status: "running" | "succeeded" | "failed";
    startedAt: number;
    completedAt?: number;
    pointsCost?: number;
    pointsRecordId?: string;
    error?: string;
};

export type GenerationLogRunSnapshot = {
    id: string;
    recordType: "generation" | "pre-generation";
    status: "planning" | "running" | "paused" | "completed" | "failed" | "cancelled";
    inputMessageId: string;
    reason?: string;
    failureStage?: string;
    childTaskIds: string[];
};

export type GenerationLogSlotSnapshot = {
    id: string;
    index: number;
    status: "pending" | "success" | "failed";
    prompt?: string;
    parameters?: GenerationLogSnapshotParameters;
    referenceIds?: string[];
    assetIndex?: number;
    clientRequestId?: string;
    taskId?: string;
    taskKind?: "generation" | "edit";
    taskProvider?: "openai" | "seedance" | "generation";
    taskModel?: string;
    taskPollPath?: string;
    taskResultUrl?: string;
    serverTaskId?: string;
    startedAt?: number;
    error?: string;
    canRetry?: boolean;
    attempts?: GenerationLogAttemptSnapshot[];
    billing?: { pointsCost: number; pointsRecordId?: string; refunded: boolean };
    upstreamTaskId?: string;
    executionPhase?: string;
    reviewReason?: string;
};

export type GenerationLogRequestSnapshot = {
    version: 1;
    userPrompt?: string;
    parameters: GenerationLogSnapshotParameters;
    references: GenerationLogReferenceSnapshot[];
    slots: GenerationLogSlotSnapshot[];
    run?: GenerationLogRunSnapshot;
};

export function generationLogPublicPrompt(log: { prompt?: string; creativeConversationId?: string; requestSnapshot?: Pick<GenerationLogRequestSnapshot, "userPrompt"> }) {
    const userPrompt = log.requestSnapshot?.userPrompt?.trim();
    if (userPrompt) return userPrompt;
    return log.creativeConversationId ? "" : String(log.prompt || "").trim();
}

export function generationLogDraftSnapshot(snapshot?: GenerationLogRequestSnapshot): GenerationLogRequestSnapshot | undefined {
    if (!snapshot) return undefined;
    return {
        version: snapshot.version,
        userPrompt: snapshot.userPrompt,
        parameters: snapshot.parameters,
        references: snapshot.references.map((reference) => ({
            id: reference.id,
            kind: reference.kind,
            name: reference.name,
            mimeType: reference.mimeType,
            url: reference.url,
            remoteUrl: reference.remoteUrl,
            serverUrl: reference.serverUrl,
            storageKey: reference.storageKey,
            bytes: reference.bytes,
            width: reference.width,
            height: reference.height,
            durationMs: reference.durationMs,
        })),
        slots: snapshot.slots.flatMap((slot) =>
            slot.status === "pending" && slot.clientRequestId
                ? [
                      {
                          id: slot.id,
                          index: slot.index,
                          status: "pending" as const,
                          prompt: slot.prompt,
                          parameters: slot.parameters,
                          referenceIds: slot.referenceIds,
                          clientRequestId: slot.clientRequestId,
                          taskKind: slot.taskKind,
                          taskModel: slot.taskModel,
                          startedAt: slot.startedAt,
                      },
                  ]
                : [],
        ),
    };
}
