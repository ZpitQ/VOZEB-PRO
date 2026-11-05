import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ImageProcessingInput, ImageProcessingEnhancementArtifact, ImageProcessingEnhancementOptions, ImageProcessingOperation, SceneProtectionEvidence } from "../image-processing/contracts";
import type { ImageProcessingResourceFacts } from "../image-processing/resource-model";
import { decideImageProcessingAdmission, estimateImageProcessingMemory } from "../image-processing/resource-model";
import { imageProcessingResourceConfig } from "../image-processing/resource-config";
import { queueRuntimeFileOperation } from "./creative-runtime-repository";
import { readJsonDataFile, withJsonDataFileLock, writeJsonDataFile } from "./data-adapter";
import { ensurePostgresSchema, getDatabaseProvider, postgresQuery, withPostgresTransaction, type QueryExecutor } from "./database";
import { getEnhancementJob, mutateEnhancementJob, withEnhancementJobFileLock, EnhancementMutationLeaseLost, type ImageEnhancementJob, type EnhancementLease } from "./database/image-enhancement-job-repository";
import { GENERATION_TASK_FILE, getStoredGenerationTaskRecord, withGenerationTaskFileRead } from "./generation-task-store";
import type { StoredGenerationTaskRecord } from "./generation-task-types";
import { enhancementNativeIdentityMatches } from "./image-enhancement-enqueue";
import { createEnhancementPublicationBinding, enhancementPublicationInputDigest, type EnhancementPublicationBinding, type EnhancementPublicationFrozenInput } from "./image-enhancement-publication-binding";
import {
    enhancementProcessingBinding,
    enhancementPublicationFactsDigest,
    enhancementManifestDigest,
    type EnhancementProcessingBinding,
    type EnhancementPublicationAdmission,
    type EnhancementPublicationCheckpoint,
} from "./image-enhancement-publication-state";
import type { ImageProcessingMediaReference, ImageProcessingManifest } from "./image-processing-service";
import type { ImageTask } from "./image-task-store";
import { getLocalMediaRegistrations, isLocalMediaRegistrationExpired, type LocalMediaRegistration } from "./local-media-registry";

export class EnhancementProcessingConflict extends Error {
    constructor(
        message: string,
        readonly status = 409,
    ) {
        super(message);
    }
}
export type EnhancementProcessingPayload = Extract<ImageProcessingOperation, { operation: "process_enhancement" }> & {
    version: "image-processing.v1";
    inputDigest: string;
    algorithmVersion: "enhancement-publication.v1";
    inputs: Omit<ImageProcessingInput, "path">[];
    sources: ImageProcessingMediaReference[];
    resource: {
        modelVersion: string;
        profileVersion: string;
        requiredMemoryBytes?: number;
        facts: ImageProcessingResourceFacts;
        configuration: Omit<ReturnType<typeof imageProcessingResourceConfig>, "profileVersion">;
        unavailable?: { code: "image_processing_resource_unavailable"; reason: "profile_uncalibrated" | "exceeds_total_budget" };
    };
    enhancementBinding: EnhancementProcessingBinding;
    enhancementInputs: EnhancementPublicationFrozenInput[];
    executionId?: string;
};
export type EnhancementProcessingTask = Omit<StoredGenerationTaskRecord, "type" | "payload"> & { type: "image_processing"; payload: EnhancementProcessingPayload };
export type PreparedEnhancementPublication = {
    binding: EnhancementPublicationBinding;
    options: ImageProcessingEnhancementOptions;
    inputs: EnhancementProcessingPayload["inputs"];
    sources: ImageProcessingMediaReference[];
    facts: ImageProcessingResourceFacts;
    frozenInputs: EnhancementPublicationFrozenInput[];
    rawAi: EnhancementPublicationCheckpoint["rawAi"];
};
type Locator = { enhancementId: string; imageTaskId: string; userId: string; childId: string };
type ChildFence = { workerId: string; executionId: string } | "claim";
export type EnhancementRelationState = {
    image: StoredGenerationTaskRecord | null;
    parent: ImageEnhancementJob;
    child: EnhancementProcessingTask | null;
    registrations: LocalMediaRegistration[];
    now: number;
};
type RelationChange<T> = { parent?: ImageEnhancementJob; child?: EnhancementProcessingTask; result: T; requireOriginal?: boolean; childFence?: ChildFence };

function conflict(message: string): never {
    throw new EnhancementProcessingConflict(message);
}
export function enhancementInputAssetVersion(registration: LocalMediaRegistration, facts: Pick<EnhancementPublicationFrozenInput, "expectedSha256" | "width" | "height">): string {
    return createHash("sha256")
        .update(
            JSON.stringify([
                "enhancement-input.v1",
                registration.storageKey,
                registration.scope,
                registration.storageClass,
                registration.type,
                registration.ownerUserId,
                registration.source,
                registration.taskId ?? null,
                registration.runId ?? null,
                registration.conversationId ?? null,
                registration.projectId ?? null,
                registration.createdAt,
                registration.storageProvider === "object" ? "object" : "local",
                registration.externalStorageId ?? null,
                registration.externalObjectKey ?? null,
                registration.mimeType,
                registration.bytes,
                facts.expectedSha256,
                facts.width,
                facts.height,
            ]),
        )
        .digest("hex");
}

export function currentEnhancementPublicationBinding(parent: ImageEnhancementJob, image: StoredGenerationTaskRecord | null, now: number): EnhancementPublicationBinding {
    if (!image || image.type !== "image" || image.userId !== parent.userId || image.id !== parent.imageTaskId || image.status !== "success" || image.expiresAt <= now) conflict("原成功图像任务身份或有效期已变化");
    const task = image.payload as ImageTask;
    if (task.id !== image.id || task.userId !== parent.userId || task.status !== "success") conflict("原成功图像任务载荷已变化");
    const results = task.result?.results?.length ? task.result.results : task.result ? [task.result] : [];
    const index = results.findIndex((result) => result.resultId === parent.resultId && result.enhancementId === parent.id);
    const original = results[index];
    if (!original || !enhancementNativeIdentityMatches(task, original, parent.decision.source, parent.decision.delivery)) conflict("native_identity_changed");
    const output = task.ecommerceTrace?.stages.find((stage) => stage.key === "image_generation")?.output;
    const technical = output && typeof output === "object" && !Array.isArray(output) ? output.technicalCheck : null;
    if (
        technical &&
        typeof technical === "object" &&
        !Array.isArray(technical) &&
        technical.version === "ecommerce-technical.v1" &&
        Array.isArray(technical.hardFailures) &&
        technical.hardFailures.some((check) => check && typeof check === "object" && !Array.isArray(check) && check.status === "failed" && (check.resultId === parent.resultId || check.resultId === "batch"))
    )
        conflict("native_invalid");
    if (parent.decision.status !== "queued" || !parent.remotePlan || !parent.remoteResult || !parent.remoteJobId || parent.remoteStatus !== "succeeded") conflict("增强远端成功身份不完整");
    const scope = parent.decision.delivery?.contract.scope;
    return createEnhancementPublicationBinding({
        enhancementId: parent.id,
        userId: parent.userId,
        imageTaskId: parent.imageTaskId,
        resultId: parent.resultId,
        resultIndex: index + 1,
        attempt: parent.attempt,
        remoteKey: parent.remoteKey,
        remoteJobId: parent.remoteJobId,
        receiptId: parent.receiptId,
        decision: parent.decision,
        remotePlan: parent.remotePlan,
        remoteResult: parent.remoteResult,
        originalProof: scope === "product_background" ? original.productEnhancementEvidence?.composition : scope === "local_edit" ? original.sceneProtectionEvidence : undefined,
    });
}

export type EnhancementInputRoles = { aiInputIndex: number; stagedDelivered?: ImageProcessingEnhancementOptions["stagedDelivered"] } & (
    { scope: "full_image" } | { scope: "product_background" | "local_edit"; sourceInputIndex: number; nativeInputIndex: number; baselineInputIndex: number; maskInputIndex: number }
);
export function enhancementOptionsForBinding(binding: EnhancementPublicationBinding, roles: EnhancementInputRoles, staged = false): ImageProcessingEnhancementOptions {
    if (staged !== Boolean(roles.stagedDelivered)) conflict("Enhancement staged delivery role must match the persisted parent stage");
    const { decision, remotePlan, remoteResult } = binding;
    const engine = decision.delivery?.contract.scope === "local_edit" ? decision.delivery.baseline : decision.source;
    const common = {
        bindingDigest: binding.bindingDigest,
        resultId: binding.resultId,
        resultIndex: binding.resultIndex,
        aiInputIndex: roles.aiInputIndex,
        engineInput: { width: engine.width, height: engine.height },
        expectedAi: { ...remoteResult },
        targetSize: { ...decision.target },
        budgets: structuredClone(remotePlan.budgets),
        ...(staged && roles.stagedDelivered ? { stagedDelivered: structuredClone(roles.stagedDelivered) } : {}),
    };
    const delivery = decision.delivery;
    if (!delivery || delivery.contract.scope === "full_image") return { ...common, scope: "full_image" };
    if (roles.scope === "full_image") conflict("增强保护输入角色缺失");
    const contract = delivery.contract;
    if (decision.source.format !== "png" && decision.source.format !== "jpeg") conflict("增强原生格式无效");
    const native: ImageProcessingEnhancementArtifact = { sha256: decision.source.sha256, byteLength: decision.source.byteLength, width: decision.source.width, height: decision.source.height, format: decision.source.format };
    const protectedInputs = {
        sourceInputIndex: roles.sourceInputIndex,
        nativeInputIndex: roles.nativeInputIndex,
        baselineInputIndex: roles.baselineInputIndex,
        maskInputIndex: roles.maskInputIndex,
        source: { sha256: contract.baseline.sha256, byteLength: contract.baseline.byteLength, width: contract.baseline.width, height: contract.baseline.height, normalizedSha256: contract.baseline.normalizedSha256 },
        native,
        baseline: { sha256: delivery.baseline.sha256, byteLength: delivery.baseline.byteLength, width: delivery.baseline.width, height: delivery.baseline.height, format: "png" as const },
    };
    if (contract.scope === "product_background") {
        if (binding.originalProof?.version !== "product-enhancement.v2") conflict("增强商品基线证明缺失");
        return { ...common, ...protectedInputs, scope: "product_background", protection: structuredClone(contract.protection), originalProof: structuredClone(binding.originalProof) };
    }
    if (!binding.originalProof || binding.originalProof.version !== "scene-edit-protection.v1") conflict("增强场景基线证明缺失");
    const { mask: _mask, ...scene } = contract.protection.scene;
    const proof = binding.originalProof;
    // The binding retains transport URLs; the CPU compares the fixed pixel-evidence schema.
    const originalProof: SceneProtectionEvidence = {
        version: proof.version,
        sourceAssetId: proof.sourceAssetId,
        sourceSize: proof.sourceSize,
        sourceDigest: proof.sourceDigest,
        maskSize: proof.maskSize,
        maskDigest: proof.maskDigest,
        targetRegion: proof.targetRegion,
        semantics: proof.semantics,
        selectionSource: proof.selectionSource,
        ...("confirmation" in proof ? { confirmation: proof.confirmation } : {}),
        maskSemantics: proof.maskSemantics,
        method: proof.method,
        nativeSize: proof.nativeSize,
        normalization: proof.normalization,
        nativeDigest: proof.nativeDigest,
        compositeDigest: proof.compositeDigest,
        outsidePixels: proof.outsidePixels,
        mappedOutsideChangedPixels: proof.mappedOutsideChangedPixels,
        ...("nativeOutsideChangedPixels" in proof ? { nativeOutsideChangedPixels: proof.nativeOutsideChangedPixels } : {}),
        compositeOutsideChangedPixels: proof.compositeOutsideChangedPixels,
    };
    return { ...common, ...protectedInputs, scope: "local_edit", protection: { version: contract.protection.version, normalization: contract.protection.normalization, scene }, originalProof: structuredClone(originalProof) };
}

function sameArtifact(value: { sha256: string; byteLength: number; width: number; height: number }, frozen: EnhancementPublicationFrozenInput) {
    return value.sha256 === frozen.expectedSha256 && value.byteLength === frozen.bytes && value.width === frozen.width && value.height === frozen.height;
}
export function assertEnhancementFrozenInputs(payload: EnhancementProcessingPayload, registrations: LocalMediaRegistration[], now: number) {
    if (payload.inputs.length !== payload.enhancementInputs.length || payload.sources.length !== payload.inputs.length) conflict("增强冻结原件数量不符");
    const options = payload.options;
    const roles = [
        options.aiInputIndex,
        ...(options.stagedDelivered ? [options.stagedDelivered.inputIndex] : []),
        ...(options.scope === "full_image" ? [] : [options.sourceInputIndex, options.nativeInputIndex, options.baselineInputIndex, options.maskInputIndex]),
    ];
    if (new Set(roles).size !== payload.inputs.length || roles.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= payload.inputs.length)) conflict("增强输入角色不能覆盖全部原件");
    for (const [index, input] of payload.inputs.entries()) {
        const frozen = payload.enhancementInputs[index];
        const source = payload.sources.find((value) => value.inputIndex === index);
        const registration = source && registrations.find((value) => value.storageKey === source.storageKey);
        if (
            !source ||
            !registration ||
            frozen.inputIndex !== index ||
            input.assetId !== frozen.assetId ||
            input.assetVersion !== frozen.assetVersion ||
            input.expectedSha256 !== frozen.expectedSha256 ||
            source.scope !== frozen.scope ||
            source.storageKey !== frozen.storageKey ||
            source.storageProvider !== frozen.storageProvider ||
            source.externalStorageId !== frozen.externalStorageId ||
            registration.ownerUserId !== payload.enhancementBinding.userId ||
            registration.ownerUserId !== frozen.ownerUserId ||
            registration.scope !== frozen.scope ||
            registration.bytes !== frozen.bytes ||
            registration.mimeType !== frozen.mimeType ||
            (registration.storageProvider === "object" ? "object" : "local") !== frozen.storageProvider ||
            registration.externalStorageId !== frozen.externalStorageId ||
            isLocalMediaRegistrationExpired(registration, now)
        )
            conflict("增强原件登记、归属或有效期已变化");
        const version = enhancementInputAssetVersion(registration, frozen);
        const maskRetention =
            options.scope !== "full_image" &&
            options.maskInputIndex === index &&
            registration.storageClass === "permanent" &&
            registration.source === "image-processing-mask" &&
            enhancementInputAssetVersion({ ...registration, storageClass: "temporary" }, frozen) === input.assetVersion;
        if (version !== input.assetVersion && !maskRetention) conflict("增强原件版本已变化");
        const encoded = payload.resource.facts.encodedInputs.find((fact) => fact.inputIndex === index);
        if (!encoded || encoded.assetId !== input.assetId || encoded.assetVersion !== input.assetVersion || encoded.sha256 !== input.expectedSha256 || encoded.bytes !== frozen.bytes) conflict("增强资源事实与原件不符");
    }
    if (!sameArtifact(options.expectedAi, payload.enhancementInputs[options.aiInputIndex])) conflict("增强AI输入身份不符");
    if (options.stagedDelivered && !sameArtifact(options.stagedDelivered.expected, payload.enhancementInputs[options.stagedDelivered.inputIndex])) conflict("增强历史交付输入身份不符");
    if (options.scope !== "full_image") {
        if (
            !sameArtifact(options.source, payload.enhancementInputs[options.sourceInputIndex]) ||
            !sameArtifact(options.native, payload.enhancementInputs[options.nativeInputIndex]) ||
            !sameArtifact(options.baseline, payload.enhancementInputs[options.baselineInputIndex])
        )
            conflict("增强保护原件身份不符");
        const mask = payload.enhancementInputs[options.maskInputIndex];
        if (mask.expectedSha256 !== (options.scope === "local_edit" ? options.protection.scene.maskDigest : options.protection.maskSha256)) conflict("增强蒙版身份不符");
    }
    if (enhancementPublicationInputDigest(payload.enhancementBinding.bindingDigest, options, payload.enhancementInputs) !== payload.inputDigest) conflict("增强原件指纹不符");
}

function assertBoundInputLocation(url: string, payload: EnhancementProcessingPayload, inputIndex: number) {
    const location = new URL(url, "http://enhancement-input.local");
    const scope = location.pathname.startsWith("/api/reference-assets/") ? "reference" : location.pathname.startsWith("/api/generation-log-assets/") ? "generation" : undefined;
    if (!scope) conflict("Enhancement input is not an owned server media location");
    const prefix = scope === "reference" ? "/api/reference-assets/" : "/api/generation-log-assets/";
    const storageKey = location.pathname.slice(prefix.length).split("/").map(decodeURIComponent).join("/");
    const source = payload.sources.find((value) => value.inputIndex === inputIndex);
    if (!source || source.scope !== scope || source.storageKey !== storageKey) conflict("Enhancement input location differs from the frozen business source");
}
function assertBoundInputRoles(parent: ImageEnhancementJob, payload: EnhancementProcessingPayload) {
    const options = payload.options;
    if (parent.staged?.ai) assertBoundInputLocation(parent.staged.ai.url, payload, options.aiInputIndex);
    const storedDelivery = parent.staged?.delivered;
    if (Boolean(storedDelivery) !== Boolean(options.stagedDelivered)) conflict("Enhancement staged delivery role must match the persisted parent stage");
    if (storedDelivery && options.stagedDelivered) {
        const { url, ...expected } = storedDelivery;
        if (!isDeepStrictEqual(options.stagedDelivered.expected, expected)) conflict("Enhancement staged delivery descriptor changed");
        assertBoundInputLocation(url, payload, options.stagedDelivered.inputIndex);
    }
    if (options.scope === "full_image") return;
    const delivery = parent.decision.delivery;
    if (!delivery || delivery.contract.scope === "full_image") conflict("Enhancement protected inputs require a protected delivery contract");
    assertBoundInputLocation(delivery.contract.baseline.url, payload, options.sourceInputIndex);
    assertBoundInputLocation(parent.decision.source.url, payload, options.nativeInputIndex);
    assertBoundInputLocation(delivery.baseline.url, payload, options.baselineInputIndex);
    const sourceAssetId = options.scope === "product_background" ? options.protection.product.sourceAssetId : options.protection.scene.sourceAssetId;
    if (payload.inputs[options.sourceInputIndex].assetId !== sourceAssetId) conflict("Enhancement protected source asset identity changed");
}

export function assertEnhancementRelation(state: EnhancementRelationState, allowTerminal = false) {
    const { parent, child, image, now } = state;
    const checkpoint = parent.publicationProcessing;
    if (
        !child ||
        child.parentTaskId !== parent.id ||
        child.runId !== undefined ||
        child.userId !== parent.userId ||
        child.expiresAt <= now ||
        child.payload.operation !== "process_enhancement" ||
        child.id !== "image-process-" + child.payload.inputDigest ||
        checkpoint?.jobId !== child.id ||
        checkpoint.inputDigest !== child.payload.inputDigest ||
        checkpoint.algorithmVersion !== child.payload.algorithmVersion ||
        checkpoint.bindingDigest !== child.payload.enhancementBinding.bindingDigest
    )
        conflict("增强父子处理检查点已变化");
    if (!allowTerminal && (parent.cancelRequested || parent.publication || parent.receiptConfirmedAt !== undefined || !["queued", "running"].includes(parent.status))) conflict("增强父任务已结束或取消");
    const binding = currentEnhancementPublicationBinding(parent, image, now);
    if (!isDeepStrictEqual(enhancementProcessingBinding(binding), child.payload.enhancementBinding) || !isDeepStrictEqual(enhancementOptionsForBinding(binding, child.payload.options, Boolean(parent.staged?.delivered)), child.payload.options))
        conflict("增强业务绑定或冻结操作已变化");
    const aiIndex = child.payload.options.aiInputIndex;
    if (
        !isDeepStrictEqual(checkpoint.rawAi.input, child.payload.inputs[aiIndex]) ||
        !isDeepStrictEqual(
            checkpoint.rawAi.source,
            child.payload.sources.find((source) => source.inputIndex === aiIndex),
        )
    )
        conflict("增强原始AI定位已变化");
    assertEnhancementFrozenInputs(child.payload, state.registrations, now);
    assertBoundInputRoles(parent, child.payload);
    return { child, checkpoint, binding };
}

function childFromRecord(record: StoredGenerationTaskRecord | null): EnhancementProcessingTask | null {
    if (!record) return null;
    if (record.type !== "image_processing" || record.payload.operation !== "process_enhancement") conflict("增强处理子任务类型冲突");
    return { ...record, type: "image_processing", payload: record.payload as EnhancementProcessingPayload };
}
async function relationClock(executor?: QueryExecutor) {
    return executor ? (await executor.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0].now.getTime() : Date.now();
}
function assertChildFence(child: EnhancementProcessingTask | null, fence: ChildFence, now: number) {
    if (!child || child.expiresAt <= now) conflict("增强处理子任务不存在或过期");
    if (fence === "claim") {
        if (!["pending", "running"].includes(child.status) || (child.leaseUntil !== undefined && child.leaseUntil > now) || !(Number(child.nextPollAt) <= now)) conflict("增强处理子任务不能领取");
    } else if (child.status !== "running" || child.workerId !== fence.workerId || child.payload.executionId !== fence.executionId || !(Number(child.leaseUntil) > now)) conflict("增强处理执行身份或租约已失效");
}
async function persistChild(executor: QueryExecutor, previous: EnhancementProcessingTask | null, next: EnhancementProcessingTask, fence?: ChildFence) {
    if (!previous) {
        const inserted = await executor.query(
            `INSERT INTO generation_tasks (id,user_id,task_type,status,payload,created_at,updated_at,expires_at,conversation_id,run_id,surface,project_id,parent_task_id,attempt_no,client_request_id,execution_phase,next_poll_at,last_upstream_status,result_payload)
          SELECT $1,$2,'image_processing',$3,$4::jsonb,$5,$6,$7,$8,NULL,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb WHERE $7 > clock_timestamp() RETURNING id`,
            [
                next.id,
                next.userId,
                next.status,
                JSON.stringify(next.payload),
                new Date(next.createdAt),
                new Date(next.updatedAt),
                new Date(next.expiresAt),
                next.conversationId || null,
                next.surface || null,
                next.projectId || null,
                next.parentTaskId,
                next.attemptNo ?? 0,
                next.clientRequestId || null,
                next.executionPhase,
                next.nextPollAt === undefined ? null : new Date(next.nextPollAt),
                next.lastUpstreamStatus || null,
                JSON.stringify(next.resultPayload || {}),
            ],
        );
        if (!inserted.rows[0]) conflict("增强处理提交前原任务已过期");
        return;
    }
    const guard =
        fence === "claim"
            ? " AND status IN ('pending','running') AND (lease_until IS NULL OR lease_until <= clock_timestamp()) AND next_poll_at <= clock_timestamp()"
            : fence
              ? " AND status='running' AND worker_id=$13 AND payload ->> 'executionId'=$14 AND lease_until > clock_timestamp()"
              : "";
    const updated = await executor.query(
        `UPDATE generation_tasks SET status=$2,payload=$3::jsonb,updated_at=$4,execution_phase=$5,next_poll_at=$6,result_payload=$7::jsonb,worker_id=$8,lease_until=$9,last_heartbeat_at=$10,attempt_no=$11,last_upstream_status=$12 WHERE id=$1 AND task_type='image_processing' AND expires_at > clock_timestamp()${guard} RETURNING id`,
        [
            next.id,
            next.status,
            JSON.stringify(next.payload),
            new Date(next.updatedAt),
            next.executionPhase,
            next.nextPollAt === undefined ? null : new Date(next.nextPollAt),
            JSON.stringify(next.resultPayload || {}),
            next.workerId || null,
            next.leaseUntil === undefined ? null : new Date(next.leaseUntil),
            next.lastHeartbeatAt === undefined ? null : new Date(next.lastHeartbeatAt),
            next.attemptNo ?? 0,
            next.lastUpstreamStatus || null,
            ...(fence && fence !== "claim" ? [fence.workerId, fence.executionId] : []),
        ],
    );
    if (!updated.rows[0]) conflict("增强处理写入时执行身份或有效期已失效");
}

export async function mutateEnhancementRelation<T>(
    locator: Locator,
    storageKeys: string[],
    transition: (state: EnhancementRelationState, executor?: QueryExecutor) => RelationChange<T> | Promise<RelationChange<T>>,
    options: { parentLease?: EnhancementLease; executor?: QueryExecutor } = {},
): Promise<T> {
    const keys = [...new Set(storageKeys)].sort();
    const perform = async (executor: QueryExecutor) => {
        const image = await getStoredGenerationTaskRecord("image", locator.imageTaskId, executor, true);
        const parent = await getEnhancementJob(locator.enhancementId, locator.userId, executor, true);
        if (!parent) conflict("增强父任务不存在");
        const child = childFromRecord(await getStoredGenerationTaskRecord("image_processing", locator.childId, executor, true));
        await executor.query("SELECT storage_key FROM local_media_assets WHERE storage_key=ANY($1::text[]) ORDER BY storage_key FOR UPDATE", [keys]);
        const registrations = await getLocalMediaRegistrations(keys, { executor });
        const now = await relationClock(executor);
        if (child && child.expiresAt <= now) conflict("Enhancement CPU child expired while waiting for relation locks");
        if (options.parentLease && (parent.leaseToken !== options.parentLease.token || parent.leaseUntil === null || parent.leaseUntil <= now)) conflict("增强父任务租约已失效");
        const state = { image, parent, child, registrations, now };
        const next = await transition(state, executor);
        const commitNow = await relationClock(executor);
        if (child && child.expiresAt <= commitNow) conflict("Enhancement CPU child expired during relation mutation");
        if (next.requireOriginal) currentEnhancementPublicationBinding(parent, image, commitNow);
        if (next.childFence) assertChildFence(child, next.childFence, commitNow);
        if (next.child && next.child !== child) await persistChild(executor, child, next.child, next.childFence);
        if (next.requireOriginal) {
            const live = await executor.query<{ live: boolean }>("SELECT expires_at > clock_timestamp() AS live FROM generation_tasks WHERE id=$1 AND task_type='image'", [locator.imageTaskId]);
            if (!live.rows[0]?.live) conflict("增强提交时原成功图像已过期");
        }
        if (next.parent && next.parent !== parent) {
            const saved = await mutateEnhancementJob(parent.id, parent.userId, () => next.parent!, options.parentLease, executor);
            if (!saved) conflict("增强父任务租约已失效");
        }
        return next.result;
    };
    const execute = async () => {
        if (options.executor) return perform(options.executor);
        if (getDatabaseProvider() === "postgres") {
            await ensurePostgresSchema();
            return withPostgresTransaction(perform);
        }
        return queueRuntimeFileOperation(() =>
            withGenerationTaskFileRead(async (records) => {
                const value = await withEnhancementJobFileLock(locator.enhancementId, locator.userId, async (parent, save) =>
                    withJsonDataFileLock("local-media-assets.json", async () => {
                        const image = records.find((record) => record.type === "image" && record.id === locator.imageTaskId) ?? null;
                        const child = childFromRecord(records.find((record) => record.type === "image_processing" && record.id === locator.childId) ?? null);
                        const registrations = await getLocalMediaRegistrations(keys);
                        const now = Date.now();
                        if (child && child.expiresAt <= now) conflict("Enhancement CPU child expired while waiting for relation locks");
                        if (options.parentLease && (parent.leaseToken !== options.parentLease.token || parent.leaseUntil === null || parent.leaseUntil <= now)) conflict("增强父任务租约已失效");
                        const next = await transition({ image, parent, child, registrations, now });
                        if (child && child.expiresAt <= Date.now()) conflict("Enhancement CPU child expired during relation mutation");
                        if (next.requireOriginal) currentEnhancementPublicationBinding(parent, image, Date.now());
                        if (next.childFence) assertChildFence(child, next.childFence, Date.now());
                        if (next.child && next.child !== child) await writeJsonDataFile(GENERATION_TASK_FILE, [...records.filter((record) => record !== child && record.id !== next.child!.id), next.child]);
                        if (next.requireOriginal) currentEnhancementPublicationBinding(parent, image, Date.now());
                        if (next.parent && next.parent !== parent) await save(next.parent, options.parentLease);
                        return { result: next.result };
                    }),
                );
                if (!value) conflict("增强父任务不存在");
                return value.result;
            }),
        );
    };
    try {
        return await execute();
    } catch (error) {
        if (error instanceof EnhancementMutationLeaseLost) throw new EnhancementProcessingConflict(error.message);
        throw error;
    }
}

export async function readEnhancementProcessingTask(id: string, executor?: QueryExecutor): Promise<EnhancementProcessingTask | null> {
    const record = await getStoredGenerationTaskRecord("image_processing", id, executor);
    return record?.payload.operation === "process_enhancement" ? childFromRecord(record) : null;
}
export function enhancementRelationLocator(child: EnhancementProcessingTask): Locator {
    const binding = child.payload.enhancementBinding;
    return { enhancementId: binding.enhancementId, imageTaskId: binding.imageTaskId, userId: binding.userId, childId: child.id };
}
export function enhancementRelationStorageKeys(child: EnhancementProcessingTask): string[] {
    return [...child.payload.sources.map((source) => source.storageKey), ...((child.resultPayload?.artifacts as { storageKey: string }[] | undefined) || []).map((artifact) => artifact.storageKey)];
}

function resourceFor(payload: Pick<EnhancementProcessingPayload, "operation" | "options" | "inputs">, facts: ImageProcessingResourceFacts) {
    const { profileVersion, ...configuration } = imageProcessingResourceConfig(process.env);
    const estimate = estimateImageProcessingMemory(payload, facts);
    const admission = decideImageProcessingAdmission(estimate, { totalMemoryBytes: configuration.budgetBytes, availableMemoryBytes: configuration.budgetBytes, availableSlots: configuration.concurrency });
    const resource: EnhancementProcessingPayload["resource"] = {
        modelVersion: estimate.modelVersion,
        profileVersion,
        configuration,
        facts,
        ...(estimate.status === "calibrated" ? { requiredMemoryBytes: estimate.requiredMemoryBytes } : {}),
        ...(admission.status === "unavailable" ? { unavailable: { code: admission.code, reason: admission.reason } } : {}),
    };
    const checkpoint: EnhancementPublicationAdmission | undefined =
        admission.status === "unavailable" ? { kind: "never_started_unavailable", code: admission.code, reason: admission.reason, modelVersion: estimate.modelVersion, profileVersion, factsDigest: enhancementPublicationFactsDigest(facts) } : undefined;
    return { resource, admission: checkpoint, estimate };
}

export async function enqueueEnhancementPublication(lease: ImageEnhancementJob, prepared: PreparedEnhancementPublication): Promise<EnhancementProcessingTask> {
    const inputDigest = enhancementPublicationInputDigest(prepared.binding.bindingDigest, prepared.options, prepared.frozenInputs);
    const id = "image-process-" + inputDigest;
    const { resource, admission } = resourceFor({ operation: "process_enhancement", options: prepared.options, inputs: prepared.inputs }, prepared.facts);
    const payload: EnhancementProcessingPayload = {
        version: "image-processing.v1",
        operation: "process_enhancement",
        algorithmVersion: "enhancement-publication.v1",
        inputDigest,
        options: prepared.options,
        inputs: prepared.inputs,
        sources: prepared.sources,
        resource,
        enhancementBinding: enhancementProcessingBinding(prepared.binding),
        enhancementInputs: prepared.frozenInputs,
    };
    return mutateEnhancementRelation(
        { enhancementId: lease.id, imageTaskId: lease.imageTaskId, userId: lease.userId, childId: id },
        prepared.sources.map((source) => source.storageKey),
        (state) => {
            const binding = currentEnhancementPublicationBinding(state.parent, state.image, state.now);
            if (
                state.parent.cancelRequested ||
                state.parent.publication ||
                binding.bindingDigest !== prepared.binding.bindingDigest ||
                !isDeepStrictEqual(enhancementOptionsForBinding(binding, payload.options, Boolean(state.parent.staged?.delivered)), payload.options)
            )
                conflict("增强提交期间业务事实已变化");
            assertEnhancementFrozenInputs(payload, state.registrations, state.now);
            assertBoundInputRoles(state.parent, payload);
            if (
                !isDeepStrictEqual(prepared.rawAi.input, payload.inputs[payload.options.aiInputIndex]) ||
                !isDeepStrictEqual(
                    prepared.rawAi.source,
                    payload.sources.find((source) => source.inputIndex === payload.options.aiInputIndex),
                )
            )
                conflict("Enhancement raw AI locator differs from the submitted input");
            let child = state.child;
            if (child) {
                const { executionId: _execution, resource: _resource, ...immutable } = child.payload;
                const { executionId: _newExecution, resource: _newResource, ...requested } = payload;
                if (child.userId !== lease.userId || child.parentTaskId !== lease.id || child.runId !== undefined || !isDeepStrictEqual(immutable, requested)) conflict("增强子任务恢复身份冲突");
            } else {
                child = {
                    id,
                    userId: lease.userId,
                    type: "image_processing",
                    status: admission ? "paused" : "pending",
                    payload,
                    createdAt: state.now,
                    updatedAt: state.now,
                    expiresAt: state.image!.expiresAt,
                    conversationId: state.image!.conversationId,
                    surface: state.image!.surface,
                    projectId: state.image!.projectId,
                    parentTaskId: lease.id,
                    attemptNo: 0,
                    clientRequestId: inputDigest,
                    executionPhase: admission ? "needs_review" : "created",
                    ...(admission ? {} : { nextPollAt: state.now }),
                    lastUpstreamStatus: admission?.code || "created",
                };
            }
            const actualUnavailable = child.payload.resource.unavailable;
            const actualAdmission: EnhancementPublicationAdmission | undefined = actualUnavailable
                ? {
                      kind: "never_started_unavailable",
                      ...actualUnavailable,
                      modelVersion: child.payload.resource.modelVersion,
                      profileVersion: child.payload.resource.profileVersion,
                      factsDigest: enhancementPublicationFactsDigest(child.payload.resource.facts),
                  }
                : undefined;
            const checkpoint: EnhancementPublicationCheckpoint = state.parent.publicationProcessing ?? {
                version: "enhancement-publication.v1",
                jobId: id,
                inputDigest,
                algorithmVersion: "enhancement-publication.v1",
                bindingDigest: binding.bindingDigest,
                rawAi: prepared.rawAi,
                ...(actualAdmission ? { admission: actualAdmission } : {}),
            };
            if (checkpoint.jobId !== child.id || checkpoint.inputDigest !== child.payload.inputDigest || checkpoint.bindingDigest !== binding.bindingDigest) conflict("增强检查点已有不同子任务");
            let parent: ImageEnhancementJob = {
                ...state.parent,
                publicationProcessing: checkpoint,
                status: checkpoint.admission ? "failed" : "running",
                phase: "publish",
                reason: checkpoint.admission?.code ?? null,
                nextPollAt: null,
                workerId: null,
                leaseToken: null,
                leaseUntil: null,
                updatedAt: state.now,
            };
            parent = awakenedEnhancementParent({ ...state, parent, child }) ?? parent;
            return { child, parent, result: child, requireOriginal: true };
        },
        { parentLease: { token: lease.leaseToken!, now: Date.now() } },
    );
}

export async function findEnhancementPublicationChild(parent: ImageEnhancementJob, bindingDigest: string): Promise<EnhancementProcessingTask | null> {
    let records: StoredGenerationTaskRecord[];
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const found = await postgresQuery<{ id: string }>(
            "SELECT id FROM generation_tasks WHERE task_type='image_processing' AND parent_task_id=$1 AND user_id=$2 AND payload ->> 'operation'='process_enhancement' AND payload #>> '{enhancementBinding,bindingDigest}'=$3 ORDER BY created_at,id LIMIT 2",
            [parent.id, parent.userId, bindingDigest],
        );
        records = [];
        for (const row of found.rows) {
            const record = await getStoredGenerationTaskRecord("image_processing", row.id);
            if (record) records.push(record);
        }
    } else
        records = await withGenerationTaskFileRead(async (all) =>
            all.filter(
                (record) =>
                    record.type === "image_processing" &&
                    record.parentTaskId === parent.id &&
                    record.userId === parent.userId &&
                    record.payload.operation === "process_enhancement" &&
                    (record.payload.enhancementBinding as EnhancementProcessingBinding).bindingDigest === bindingDigest,
            ),
        );
    if (records.length > 1) conflict("同一增强业务存在冲突子任务");
    return childFromRecord(records[0] ?? null);
}

export type ClosedEnhancementResult = {
    executionId: string;
    workerId: string;
    manifest?: ImageProcessingManifest;
    manifestDigest?: string;
    failure?: Extract<import("../image-processing/contracts").ImageProcessingOutcome, { status: "rejected" | "resource_failure" }>;
    artifacts?: import("./image-processing-service").StoredImageProcessingArtifact[];
    metrics?: import("../image-processing/contracts").ImageProcessingResult["metrics"];
    parentRescheduled?: boolean;
};
export function closedEnhancementOutcome(child: EnhancementProcessingTask): EnhancementPublicationCheckpoint["outcome"] {
    const result = child.resultPayload as ClosedEnhancementResult | undefined;
    if (!result || !result.workerId || !result.executionId || child.payload.executionId !== result.executionId || child.workerId !== undefined || child.leaseUntil !== undefined) return;
    if (child.status === "success" && child.executionPhase === "completed" && result.manifest && result.manifestDigest === enhancementManifestDigest(result.manifest) && !result.failure)
        return { status: "completed", executionId: result.executionId, attemptNo: child.attemptNo ?? 0, manifestDigest: result.manifestDigest, manifest: result.manifest };
    if ((child.status === "error" || child.status === "paused") && child.executionPhase === "needs_review" && result.failure && result.failure.jobId === child.id && result.failure.executionId === result.executionId && !result.manifest)
        return { status: "failed", executionId: result.executionId, attemptNo: child.attemptNo ?? 0, failure: result.failure };
}
export function awakenedEnhancementParent(state: EnhancementRelationState): ImageEnhancementJob | undefined {
    const outcome = state.child && closedEnhancementOutcome(state.child);
    if (!outcome || state.parent.cancelRequested || state.parent.publication || !["queued", "running"].includes(state.parent.status) || state.parent.phase !== "publish") return;
    try {
        assertEnhancementRelation(state);
    } catch (error) {
        if (error instanceof EnhancementProcessingConflict) return;
        throw error;
    }
    const checkpoint = state.parent.publicationProcessing!;
    if (isDeepStrictEqual(checkpoint.outcome, outcome) && state.parent.nextPollAt !== null) return;
    return { ...state.parent, publicationProcessing: { ...checkpoint, admission: undefined, outcome }, nextPollAt: state.now, updatedAt: state.now };
}
export async function repairEnhancementPublicationWakes(limit: number): Promise<number> {
    let candidates: Locator[];
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const found = await postgresQuery<{ id: string; user_id: string; image_task_id: string; child_id: string }>(
            `SELECT enhancement.id,enhancement.user_id,enhancement.image_task_id,child.id AS child_id
             FROM image_enhancement_jobs AS enhancement JOIN generation_tasks AS child ON child.id=enhancement.payload #>> '{publicationProcessing,jobId}'
             WHERE enhancement.status IN ('queued','running') AND enhancement.phase='publish' AND enhancement.next_poll_at IS NULL
               AND enhancement.payload ->> 'cancelRequested'='false' AND enhancement.payload -> 'publication' IS NULL
               AND enhancement.payload #> '{publicationProcessing,admission}' IS NULL
               AND child.task_type='image_processing' AND child.status IN ('success','error','paused')
               AND child.result_payload ->> 'executionId' IS NOT NULL
             ORDER BY enhancement.updated_at,enhancement.id LIMIT $1`,
            [limit],
        );
        candidates = found.rows.map((row) => ({ enhancementId: row.id, imageTaskId: row.image_task_id, userId: row.user_id, childId: row.child_id }));
    } else
        candidates = await withGenerationTaskFileRead(async (records) => {
            const parents = await readJsonDataFile<ImageEnhancementJob[]>("image-enhancement-jobs.json", []);
            return parents
                .filter(
                    (parent) =>
                        ["queued", "running"].includes(parent.status) &&
                        parent.phase === "publish" &&
                        parent.nextPollAt === null &&
                        !parent.cancelRequested &&
                        !parent.publication &&
                        parent.publicationProcessing &&
                        !parent.publicationProcessing.admission &&
                        records.some((record) => record.id === parent.publicationProcessing!.jobId && ["success", "error", "paused"].includes(record.status) && record.resultPayload?.executionId),
                )
                .sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id))
                .slice(0, limit)
                .map((parent) => ({ enhancementId: parent.id, imageTaskId: parent.imageTaskId, userId: parent.userId, childId: parent.publicationProcessing!.jobId }));
        });
    let repaired = 0;
    for (const candidate of candidates) {
        const child = await readEnhancementProcessingTask(candidate.childId);
        if (!child) continue;
        repaired += await mutateEnhancementRelation(candidate, enhancementRelationStorageKeys(child), (state) => {
            const parent = awakenedEnhancementParent(state);
            return { parent, result: parent ? 1 : 0 };
        });
    }
    return repaired;
}

export async function closeEnhancementProcessingFailure(initial: EnhancementProcessingTask, input: import("./image-processing-service").FailImageProcessingInput): Promise<import("./image-processing-service").FailedImageProcessingStage> {
    if (input.failure.jobId !== initial.id || input.failure.executionId !== input.executionId) conflict("增强失败报告身份不符");
    const failure = input.failure;
    const status = failure.status === "rejected" ? ("error" as const) : ("paused" as const);
    return mutateEnhancementRelation(enhancementRelationLocator(initial), enhancementRelationStorageKeys(initial), (state) => {
        const child = state.child;
        if (!child || !isDeepStrictEqual(child.payload, initial.payload)) conflict("增强处理冻结身份已变化");
        const previous = child.resultPayload as ClosedEnhancementResult | undefined;
        const response = { jobId: child.id, status, executionPhase: "needs_review" as const };
        if (child.status !== "running") {
            if (child.status !== status || previous?.workerId !== input.workerId || previous.executionId !== input.executionId || !isDeepStrictEqual(previous.failure, failure)) conflict("增强失败回执冲突");
            return { parent: awakenedEnhancementParent(state), result: response };
        }
        const closed: EnhancementProcessingTask = {
            ...child,
            status,
            executionPhase: "needs_review",
            updatedAt: state.now,
            nextPollAt: undefined,
            workerId: undefined,
            leaseUntil: undefined,
            lastHeartbeatAt: undefined,
            resultPayload: { ...child.resultPayload, executionId: input.executionId, workerId: input.workerId, failure },
            lastUpstreamStatus: failure.status === "rejected" ? failure.error.code : failure.reason,
        };
        return { child: closed, parent: awakenedEnhancementParent({ ...state, child: closed }), result: response, childFence: { workerId: input.workerId, executionId: input.executionId } };
    });
}

function assertExplicitResumeOwner(state: EnhancementRelationState, expected: ImageEnhancementJob) {
    const owner = [state.parent.workerId, state.parent.leaseToken, state.parent.leaseUntil];
    if (
        owner.some((value) => value !== null) &&
        (!state.parent.workerId || !state.parent.leaseToken || state.parent.leaseUntil === null || state.parent.leaseUntil > state.now || !isDeepStrictEqual(owner, [expected.workerId, expected.leaseToken, expected.leaseUntil]))
    )
        conflict("Enhancement parent has a different live execution owner");
}
function resumedEnhancementParent(state: EnhancementRelationState, checkpoint: EnhancementPublicationCheckpoint): ImageEnhancementJob {
    return { ...state.parent, publicationProcessing: checkpoint, status: "running", phase: "publish", reason: null, nextPollAt: null, workerId: null, leaseToken: null, leaseUntil: null, updatedAt: state.now };
}
function unclaimedResumeChild(child: EnhancementProcessingTask) {
    return child.status === "pending" && child.executionPhase === "created" && child.payload.executionId === undefined && child.workerId === undefined && child.leaseUntil === undefined && child.lastHeartbeatAt === undefined;
}
type ClosedEnhancementAttempt = Omit<ClosedEnhancementResult, "parentRescheduled"> & { attemptNo: number; resource: EnhancementProcessingPayload["resource"] };

export async function resumeUnstartedEnhancementPublication(expected: ImageEnhancementJob, verifiedFacts: ImageProcessingResourceFacts): Promise<ImageEnhancementJob> {
    const checkpoint = expected.publicationProcessing;
    if (!checkpoint) conflict("Enhancement admission checkpoint is missing");
    const initial = await readEnhancementProcessingTask(checkpoint.jobId);
    if (!initial) conflict("Enhancement CPU child is missing");
    return mutateEnhancementRelation(enhancementRelationLocator(initial), enhancementRelationStorageKeys(initial), (state) => {
        const { child, checkpoint: current } = assertEnhancementRelation(state, true);
        if (
            state.parent.cancelRequested ||
            state.parent.publication ||
            state.parent.receiptConfirmedAt !== undefined ||
            state.parent.phase !== "publish" ||
            !isDeepStrictEqual(child.payload, initial.payload) ||
            !isDeepStrictEqual(child.payload.resource.facts, verifiedFacts)
        )
            conflict("Enhancement admission resume facts changed");
        const resumedAdmission = child.resultPayload?.admissionResume as EnhancementPublicationAdmission | undefined;
        if (!current.admission && !current.outcome && state.parent.status === "running" && resumedAdmission && ["pending", "running"].includes(child.status)) return { result: state.parent };
        const admission = current.admission;
        if (!admission || state.parent.status !== "failed" || state.parent.reason !== admission.code || current.outcome || child.attemptNo !== 0 || enhancementPublicationFactsDigest(verifiedFacts) !== admission.factsDigest)
            conflict("Enhancement is not a never-started resource pause");
        assertExplicitResumeOwner(state, expected);
        const refreshed = resourceFor(child.payload, verifiedFacts);
        if (refreshed.resource.profileVersion === admission.profileVersion || refreshed.estimate.status !== "calibrated" || refreshed.resource.unavailable)
            conflict(refreshed.resource.unavailable?.reason || "Enhancement resource configuration has not changed");
        const ownProfile =
            child.payload.options.scope === "product_background"
                ? "enhancement_product"
                : child.payload.options.scope === "local_edit"
                  ? "enhancement_scene"
                  : child.payload.options.stagedDelivered?.expected.format === "png"
                    ? "enhancement_legacy_png"
                    : "enhancement_global_jpeg";
        if (refreshed.estimate.profile !== ownProfile || (admission.reason === "profile_uncalibrated" && refreshed.estimate.modelVersion === admission.modelVersion)) conflict("Enhancement profile is still uncalibrated");
        const parent = resumedEnhancementParent(state, { ...current, admission: undefined });
        // A File child save can survive a failed parent rename. Only finish that exact durable transition.
        if (resumedAdmission) {
            if (!unclaimedResumeChild(child) || !isDeepStrictEqual(resumedAdmission, admission) || !isDeepStrictEqual(child.payload.resource, refreshed.resource) || !isDeepStrictEqual(child.resultPayload, { admissionResume: admission }))
                conflict("Enhancement admission resume transition does not match");
            return { parent, result: parent, requireOriginal: true };
        }
        if (
            child.status !== "paused" ||
            child.executionPhase !== "needs_review" ||
            child.payload.executionId !== undefined ||
            child.workerId !== undefined ||
            child.leaseUntil !== undefined ||
            child.lastHeartbeatAt !== undefined ||
            Object.keys(child.resultPayload || {}).length !== 0 ||
            !isDeepStrictEqual(child.payload.resource.unavailable, { code: admission.code, reason: admission.reason }) ||
            child.payload.resource.profileVersion !== admission.profileVersion ||
            child.payload.resource.modelVersion !== admission.modelVersion
        )
            conflict("Enhancement child is not the original never-started resource pause");
        const nextChild: EnhancementProcessingTask = {
            ...child,
            status: "pending",
            executionPhase: "created",
            payload: { ...child.payload, resource: refreshed.resource },
            resultPayload: { admissionResume: admission },
            nextPollAt: state.now,
            updatedAt: state.now,
            lastUpstreamStatus: "resource_resume",
        };
        return { child: nextChild, parent, result: parent, requireOriginal: true };
    });
}

export async function resumeClosedEnhancementPublication(expected: ImageEnhancementJob, verifiedFacts: ImageProcessingResourceFacts): Promise<ImageEnhancementJob> {
    const checkpoint = expected.publicationProcessing;
    if (!checkpoint) conflict("Enhancement closed CPU checkpoint is missing");
    const initial = await readEnhancementProcessingTask(checkpoint.jobId);
    if (!initial) conflict("Enhancement CPU child is missing");
    return mutateEnhancementRelation(enhancementRelationLocator(initial), enhancementRelationStorageKeys(initial), (state) => {
        const { child, checkpoint: current } = assertEnhancementRelation(state, true);
        if (
            state.parent.cancelRequested ||
            state.parent.publication ||
            state.parent.receiptConfirmedAt !== undefined ||
            state.parent.phase !== "publish" ||
            current.admission ||
            !isDeepStrictEqual(initial.payload, child.payload) ||
            !isDeepStrictEqual(child.payload.resource.facts, verifiedFacts)
        )
            conflict("Enhancement closed retry facts changed");
        if (current.outcome?.status === "completed") {
            const outcome = closedEnhancementOutcome(child);
            if (state.parent.status !== "failed" || !isDeepStrictEqual(outcome, current.outcome)) conflict("Enhancement has no matching completed CPU publication failure");
            assertExplicitResumeOwner(state, expected);
            const parent = { ...resumedEnhancementParent(state, current), nextPollAt: state.now };
            return { parent, result: parent, requireOriginal: true };
        }
        const history = (child.resultPayload?.checkpoints as ClosedEnhancementAttempt[] | undefined) || [];
        const retried = history.at(-1);
        if (!current.outcome && state.parent.status === "running" && retried && ["pending", "running"].includes(child.status)) return { result: state.parent };
        if (state.parent.status !== "failed" || current.outcome?.status !== "failed") conflict("Enhancement has no matching closed CPU failure");
        assertExplicitResumeOwner(state, expected);
        const refreshed = resourceFor(child.payload, verifiedFacts);
        if (refreshed.resource.unavailable) conflict(refreshed.resource.unavailable.reason);
        const parent = resumedEnhancementParent(state, { ...current, outcome: undefined });
        if (unclaimedResumeChild(child)) {
            if (
                !retried ||
                !retried.failure ||
                retried.manifest ||
                retried.executionId !== current.outcome.executionId ||
                retried.attemptNo !== current.outcome.attemptNo ||
                child.attemptNo !== retried.attemptNo + 1 ||
                !isDeepStrictEqual(retried.failure, current.outcome.failure) ||
                !isDeepStrictEqual(child.payload.resource, refreshed.resource) ||
                !isDeepStrictEqual(child.resultPayload, { checkpoints: history })
            )
                conflict("Enhancement closed retry transition does not match");
            return { parent, result: parent, requireOriginal: true };
        }
        const outcome = closedEnhancementOutcome(child);
        const previous = child.resultPayload as (ClosedEnhancementResult & { checkpoints?: ClosedEnhancementAttempt[] }) | undefined;
        if (outcome?.status !== "failed" || !previous || !isDeepStrictEqual(current.outcome, outcome)) conflict("Enhancement has no matching real closed CPU failure receipt");
        const { executionId: _execution, ...frozen } = child.payload;
        const { checkpoints: _history, parentRescheduled: _wake, ...closed } = previous;
        const nextChild: EnhancementProcessingTask = {
            ...child,
            status: "pending",
            executionPhase: "created",
            payload: { ...frozen, resource: refreshed.resource },
            attemptNo: outcome.attemptNo + 1,
            nextPollAt: state.now,
            updatedAt: state.now,
            lastUpstreamStatus: "explicit_cpu_retry",
            resultPayload: { checkpoints: [...history, { ...closed, attemptNo: outcome.attemptNo, resource: child.payload.resource }] },
        };
        return { child: nextChild, parent, result: parent, requireOriginal: true };
    });
}
