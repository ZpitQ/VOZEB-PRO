import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import sharp from "sharp";
import { imageMimeType, orientedDimensions } from "../image-processing/generated-image";
import { enhancementManifestDigest } from "./image-enhancement-publication-state";
import type { ImageEnhancementJob } from "./database/image-enhancement-job-repository";
import { writeReferenceMediaFile } from "./reference-asset-store";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ImageProcessingEnhancementOptions } from "../image-processing/contracts";
import { imageProcessingResourceConfig } from "../image-processing/resource-config";
import type { QueryExecutor } from "./database";
import type { ClaimImageProcessingInput, ClaimedImageProcessingTask, CompleteImageProcessingInput, CompletedImageProcessingStage, ImageProcessingManifest, StoredImageProcessingArtifact } from "./image-processing-service";
import {
    assertEnhancementRelation,
    awakenedEnhancementParent,
    enhancementRelationLocator,
    enhancementRelationStorageKeys,
    EnhancementProcessingConflict,
    mutateEnhancementRelation,
    readEnhancementProcessingTask,
    resumeUnstartedEnhancementPublication as resumeUnstartedStore,
    resumeClosedEnhancementPublication,
    type EnhancementProcessingTask,
} from "./image-enhancement-processing-store";
import { readEnhancementProcessingFacts, readVerifiedEnhancementArtifact, enhancementRegisteredStream } from "./image-enhancement-processing-media";

function reject(message: string): never {
    throw new EnhancementProcessingConflict(message);
}
function currentChild(initial: EnhancementProcessingTask, current: EnhancementProcessingTask | null) {
    if (!current || current.id !== initial.id || !isDeepStrictEqual(current.payload, initial.payload)) reject("增强处理冻结输入或执行身份已变化");
    return current;
}
function currentOwner(child: EnhancementProcessingTask, identity: { workerId: string; executionId: string }, now: number, allowCancelled = false) {
    const cancelled = child.status === "cancelled" && child.executionPhase === "cancel_requested";
    if (child.expiresAt <= now || child.workerId !== identity.workerId || child.payload.executionId !== identity.executionId || !(Number(child.leaseUntil) > now) || (child.status !== "running" && !(allowCancelled && cancelled)))
        reject("增强处理执行身份或租约已失效");
    return cancelled;
}
function expectedDeliverySize(options: ImageProcessingEnhancementOptions) {
    if (options.scope !== "full_image") return options.targetSize;
    const scale = Math.min(1, options.targetSize.width / options.expectedAi.width, options.targetSize.height / options.expectedAi.height);
    return { width: Math.round(options.expectedAi.width * scale), height: Math.round(options.expectedAi.height * scale) };
}
export function assertEnhancementProcessingManifest(child: EnhancementProcessingTask, input: CompleteImageProcessingInput) {
    const options = child.payload.options;
    const { manifest } = input;
    const result = manifest.enhancement;
    const stored = child.resultPayload?.artifacts as StoredImageProcessingArtifact[] | undefined;
    const artifact = manifest.artifacts[0];
    const size = expectedDeliverySize(options);
    const format = options.stagedDelivered?.expected.format ?? (options.scope === "full_image" ? "jpeg" : "png");
    const geometry = options.scope === "full_image" ? { width: options.expectedAi.width, height: options.expectedAi.height } : { width: options.source.width, height: options.source.height };
    if (
        manifest.jobId !== child.id ||
        manifest.executionId !== input.executionId ||
        manifest.results !== undefined ||
        manifest.sourceIdentities.length !== child.payload.inputs.length ||
        manifest.artifacts.length !== 1 ||
        !stored ||
        stored.length !== 1 ||
        !artifact ||
        !isDeepStrictEqual(artifact, stored[0]) ||
        artifact.kind !== "final" ||
        artifact.resultId !== options.resultId ||
        artifact.resultIndex !== options.resultIndex ||
        artifact.layerKind !== undefined ||
        artifact.width !== size.width ||
        artifact.height !== size.height ||
        artifact.mimeType !== "image/" + format ||
        artifact.bytes > options.budgets.delivery.maxBytes ||
        artifact.width * artifact.height > Math.min(40_000_000, options.budgets.delivery.maxPixels) ||
        !isDeepStrictEqual(manifest.geometry, { sourceSize: geometry }) ||
        result?.version !== "enhancement-processing-result.v1" ||
        result.bindingDigest !== options.bindingDigest ||
        result.scope !== options.scope ||
        result.aiInputIndex !== options.aiInputIndex ||
        !isDeepStrictEqual(result.ai, options.expectedAi) ||
        result.deliveredArtifactIndex !== 0 ||
        (result.deliveryEncodingMs !== undefined && (!Number.isFinite(result.deliveryEncodingMs) || result.deliveryEncodingMs < 0))
    )
        reject("增强完成清单与冻结操作或上传工件不符");
    for (const [index, source] of manifest.sourceIdentities.entries()) {
        const frozen = child.payload.enhancementInputs[index];
        if (
            source.decodeError ||
            source.assetId !== frozen.assetId ||
            source.assetVersion !== frozen.assetVersion ||
            source.sha256 !== frozen.expectedSha256 ||
            source.bytes !== frozen.bytes ||
            source.width !== frozen.width ||
            source.height !== frozen.height ||
            source.mimeType !== frozen.mimeType
        )
            reject("增强完成清单原件事实不符");
    }
    if (options.stagedDelivered && (artifact.sha256 !== options.stagedDelivered.expected.sha256 || artifact.bytes !== options.stagedDelivered.expected.byteLength || result.deliveryEncodingMs !== undefined)) reject("增强历史交付复用事实不符");
    const proof = result.protection;
    if (options.scope === "full_image") {
        if (proof !== undefined) reject("全图增强不能附带保护证明");
    } else {
        if (
            !proof ||
            proof.version !== options.protection.version ||
            proof.normalization !== options.protection.normalization ||
            proof.sourceAssetId !== (options.scope === "local_edit" ? options.protection.scene.sourceAssetId : options.protection.product.sourceAssetId) ||
            proof.sourceSha256 !== options.baseline.sha256 ||
            proof.maskSha256 !== (options.scope === "local_edit" ? options.protection.scene.maskDigest : options.protection.maskSha256) ||
            proof.aiSha256 !== options.expectedAi.sha256 ||
            proof.compositeSha256 !== artifact.sha256 ||
            !isDeepStrictEqual(proof.sourceSize, options.targetSize) ||
            !isDeepStrictEqual(proof.aiSize, { width: options.expectedAi.width, height: options.expectedAi.height }) ||
            !Number.isSafeInteger(proof.allowedPixels) ||
            proof.allowedPixels <= 0 ||
            !Number.isSafeInteger(proof.protectedPixels) ||
            proof.protectedPixels <= 0 ||
            proof.allowedPixels + proof.protectedPixels !== options.targetSize.width * options.targetSize.height ||
            proof.protectedChangedPixels !== 0
        )
            reject("增强保护证明与冻结身份不符");
        if (options.scope === "product_background" && (proof.version !== "product-enhancement.v2" || proof.productAnchorId !== options.protection.product.productAnchorId)) reject("增强商品锚点已变化");
        if (
            options.scope === "local_edit" &&
            (proof.version !== "scene-enhancement.v1" || !isDeepStrictEqual(proof.mapping.context, { x: 0, y: 0, ...options.protection.scene.sourceSize }) || !isDeepStrictEqual(proof.mapping.targetRegion, options.protection.scene.targetRegion))
        )
            reject("增强局部映射已变化");
    }
    if (!Number.isSafeInteger(input.metrics.pid) || input.metrics.pid <= 0) reject("增强完成报告缺少真实子进程身份");
}

export async function stageEnhancementProcessingArtifact(initial: EnhancementProcessingTask, identity: { workerId: string; executionId: string }, artifact: StoredImageProcessingArtifact) {
    return mutateEnhancementRelation(enhancementRelationLocator(initial), [...enhancementRelationStorageKeys(initial), artifact.storageKey], (state) => {
        const child = currentChild(initial, state.child);
        currentOwner(child, identity, state.now);
        assertEnhancementRelation(state);
        const options = child.payload.options;
        const size = expectedDeliverySize(options);
        const format = options.stagedDelivered?.expected.format ?? (options.scope === "full_image" ? "jpeg" : "png");
        const registration = state.registrations.find((value) => value.storageKey === artifact.storageKey);
        if (
            artifact.kind !== "final" ||
            artifact.resultId !== options.resultId ||
            artifact.resultIndex !== options.resultIndex ||
            artifact.layerKind !== undefined ||
            artifact.mimeType !== "image/" + format ||
            artifact.width !== size.width ||
            artifact.height !== size.height ||
            artifact.bytes > options.budgets.delivery.maxBytes ||
            !registration ||
            registration.ownerUserId !== child.userId ||
            registration.scope !== "reference" ||
            registration.type !== "image" ||
            registration.taskId !== child.id ||
            registration.source !== "image-processing-final" ||
            registration.bytes !== artifact.bytes ||
            registration.mimeType !== artifact.mimeType ||
            (registration.storageClass === "temporary" && registration.expiresAt !== undefined && Date.parse(registration.expiresAt) <= state.now)
        )
            reject("增强交付上传工件或登记不符");
        const previous = child.resultPayload?.artifacts as StoredImageProcessingArtifact[] | undefined;
        if (previous?.length) {
            if (previous.length !== 1 || !isDeepStrictEqual(previous[0], artifact)) reject("增强交付工件已有不同上传");
            return { result: previous[0] };
        }
        const next = { ...child, updatedAt: state.now, resultPayload: { ...child.resultPayload, executionId: identity.executionId, artifacts: [artifact] } };
        return { child: next, result: artifact, childFence: identity, requireOriginal: true };
    });
}

export async function completeEnhancementProcessing(initial: EnhancementProcessingTask, input: CompleteImageProcessingInput): Promise<CompletedImageProcessingStage> {
    const artifact = input.manifest.artifacts[0];
    if (!artifact) reject("增强完成清单缺少交付工件");
    const verified = await readVerifiedEnhancementArtifact(initial, artifact);
    try {
        return await mutateEnhancementRelation(enhancementRelationLocator(initial), [...enhancementRelationStorageKeys(initial), artifact.storageKey], (state) => {
            const child = currentChild(initial, state.child);
            const previous = child.resultPayload;
            const digest = enhancementManifestDigest(input.manifest);
            assertEnhancementProcessingManifest(child, input);
            const currentRegistration = state.registrations.find((value) => value.storageKey === artifact.storageKey);
            if (
                !currentRegistration ||
                !isDeepStrictEqual(currentRegistration, verified.registration) ||
                (currentRegistration.storageClass === "temporary" && currentRegistration.expiresAt !== undefined && Date.parse(currentRegistration.expiresAt) <= state.now)
            )
                reject("增强完成期间工件登记已变化或失效");
            if (child.status === "success") {
                if (previous?.executionId !== input.executionId || previous.workerId !== input.workerId || previous.manifestDigest !== digest) reject("增强已完成执行回执冲突");
                const parent = awakenedEnhancementParent(state);
                return {
                    parent,
                    result: { jobId: child.id, inputDigest: child.payload.inputDigest, executionId: input.executionId, manifest: previous.manifest as ImageProcessingManifest, parentRescheduled: Boolean(parent) || previous.parentRescheduled === true },
                };
            }
            currentOwner(child, input, state.now);
            const closed: EnhancementProcessingTask = {
                ...child,
                status: "success",
                executionPhase: "completed",
                updatedAt: state.now,
                nextPollAt: undefined,
                workerId: undefined,
                leaseUntil: undefined,
                lastHeartbeatAt: undefined,
                resultPayload: { ...child.resultPayload, executionId: input.executionId, workerId: input.workerId, manifest: input.manifest, manifestDigest: digest, metrics: input.metrics, parentRescheduled: false },
            };
            const parent = awakenedEnhancementParent({ ...state, child: closed });
            closed.resultPayload!.parentRescheduled = Boolean(parent);
            return {
                child: closed,
                parent,
                result: { jobId: child.id, inputDigest: child.payload.inputDigest, executionId: input.executionId, manifest: input.manifest, parentRescheduled: Boolean(parent) },
                childFence: { workerId: input.workerId, executionId: input.executionId },
            };
        });
    } finally {
        await verified.dispose();
    }
}

export async function claimEnhancementProcessingTask(initial: EnhancementProcessingTask, input: ClaimImageProcessingInput, executor?: QueryExecutor): Promise<ClaimedImageProcessingTask | null> {
    const configuration = imageProcessingResourceConfig(process.env);
    if (executor) {
        const binding = initial.payload.enhancementBinding;
        const image = await executor.query("SELECT id FROM generation_tasks WHERE id=$1 AND task_type='image' AND user_id=$2 FOR UPDATE SKIP LOCKED", [binding.imageTaskId, binding.userId]);
        if (!image.rows[0]) return null;
        const parent = await executor.query("SELECT id FROM image_enhancement_jobs WHERE id=$1 AND user_id=$2 FOR UPDATE SKIP LOCKED", [binding.enhancementId, binding.userId]);
        if (!parent.rows[0]) return null;
        const child = await executor.query("SELECT id FROM generation_tasks WHERE id=$1 AND task_type='image_processing' AND user_id=$2 FOR UPDATE SKIP LOCKED", [initial.id, binding.userId]);
        if (!child.rows[0]) return null;
        const keys = [...new Set(enhancementRelationStorageKeys(initial))].sort();
        const registrations = await executor.query("SELECT storage_key FROM local_media_assets WHERE storage_key=ANY($1::text[]) ORDER BY storage_key FOR UPDATE SKIP LOCKED", [keys]);
        if (registrations.rows.length !== keys.length) return null;
    }
    return mutateEnhancementRelation(
        enhancementRelationLocator(initial),
        enhancementRelationStorageKeys(initial),
        (state) => {
            let child: EnhancementProcessingTask;
            try {
                child = currentChild(initial, state.child);
                assertEnhancementRelation(state);
            } catch (error) {
                if (error instanceof EnhancementProcessingConflict) return { result: null };
                throw error;
            }
            const resource = child.payload.resource;
            if (
                child.status !== "pending" ||
                child.payload.executionId !== undefined ||
                child.workerId !== undefined ||
                child.leaseUntil !== undefined ||
                resource.unavailable ||
                resource.profileVersion !== input.profileVersion ||
                resource.profileVersion !== configuration.profileVersion ||
                !Number.isSafeInteger(resource.requiredMemoryBytes) ||
                resource.requiredMemoryBytes! <= 0 ||
                resource.requiredMemoryBytes! > input.availableMemoryBytes ||
                !(Number(child.nextPollAt) <= state.now)
            )
                return { result: null };
            const executionId = randomUUID();
            const leaseUntil = state.now + 90_000;
            const payload = { ...child.payload, executionId };
            const next: EnhancementProcessingTask = { ...child, status: "running", executionPhase: "created", payload, workerId: input.workerId, leaseUntil, lastHeartbeatAt: state.now, updatedAt: state.now };
            return {
                child: next,
                result: { id: child.id, executionId, leaseUntil, payload, inputUrls: payload.inputs.map((value) => `/api/maintenance/image-processing/${encodeURIComponent(child.id)}/inputs/${encodeURIComponent(value.assetId)}`) },
                childFence: "claim" as const,
                requireOriginal: true,
            };
        },
        { executor },
    );
}

export async function heartbeatEnhancementProcessing(initial: EnhancementProcessingTask, identity: { workerId: string; executionId: string }) {
    return mutateEnhancementRelation(enhancementRelationLocator(initial), enhancementRelationStorageKeys(initial), (state) => {
        const child = currentChild(initial, state.child);
        const cancelled = currentOwner(child, identity, state.now, true);
        if (cancelled) return { result: { leaseUntil: child.leaseUntil!, cancelRequested: true } };
        let cancelRequested = false;
        try {
            assertEnhancementRelation(state);
        } catch (error) {
            if (!(error instanceof EnhancementProcessingConflict)) throw error;
            cancelRequested = true;
        }
        const leaseUntil = cancelRequested ? child.leaseUntil! : state.now + 90_000;
        const next: EnhancementProcessingTask = { ...child, ...(cancelRequested ? { status: "cancelled", executionPhase: "cancel_requested" } : {}), leaseUntil, lastHeartbeatAt: state.now, updatedAt: state.now };
        return { child: next, result: { leaseUntil, cancelRequested }, childFence: identity };
    });
}

export async function readEnhancementProcessingInput(initial: EnhancementProcessingTask, assetId: string, identity: { workerId: string; executionId: string }, signal?: AbortSignal) {
    const checked = await mutateEnhancementRelation(enhancementRelationLocator(initial), enhancementRelationStorageKeys(initial), (state) => {
        const child = currentChild(initial, state.child);
        currentOwner(child, identity, state.now);
        assertEnhancementRelation(state);
        const index = child.payload.inputs.findIndex((input) => input.assetId === assetId);
        if (index < 0) reject("素材不在增强输入清单");
        const source = child.payload.sources.find((value) => value.inputIndex === index)!;
        const registration = state.registrations.find((value) => value.storageKey === source.storageKey)!;
        return { result: { registration, bytes: child.payload.enhancementInputs[index].bytes } };
    });
    return { stream: await enhancementRegisteredStream(checked.registration, signal), mimeType: checked.registration.mimeType, bytes: checked.bytes };
}
export async function writeEnhancementProcessingOutput(
    initial: EnhancementProcessingTask,
    kind: StoredImageProcessingArtifact["kind"],
    identity: { workerId: string; executionId: string },
    input: { stream: ReadableStream<Uint8Array>; mimeType: string; signal?: AbortSignal; resultId?: string },
) {
    const options = initial.payload.options;
    const format = options.stagedDelivered?.expected.format ?? (options.scope === "full_image" ? "jpeg" : "png");
    if (kind !== "final" || input.resultId !== options.resultId || input.mimeType !== "image/" + format) throw new EnhancementProcessingConflict("增强处理仅接受冻结槽位和格式的final工件", 400);
    await mutateEnhancementRelation(enhancementRelationLocator(initial), enhancementRelationStorageKeys(initial), (state) => {
        currentOwner(currentChild(initial, state.child), identity, state.now);
        assertEnhancementRelation(state);
        return { result: undefined };
    });
    const directory = await mkdtemp(join(tmpdir(), "vozeb-enhancement-output-"));
    const filename = join(directory, "closed-final");
    try {
        const hash = createHash("sha256");
        let bytes = 0;
        const meter = new Transform({
            transform(chunk: Buffer, _encoding, done) {
                bytes += chunk.length;
                if (bytes > options.budgets.delivery.maxBytes) return done(new EnhancementProcessingConflict("增强交付超过冻结字节限制", 413));
                hash.update(chunk);
                done(null, chunk);
            },
        });
        await pipeline(Readable.fromWeb(input.stream as NodeReadableStream<Uint8Array>), meter, createWriteStream(filename, { flags: "wx" }), { signal: input.signal });
        const metadata = await sharp(filename, { failOn: "warning", limitInputPixels: Math.min(40_000_000, options.budgets.delivery.maxPixels) }).metadata();
        const size = orientedDimensions(metadata);
        if (
            imageMimeType(metadata) !== input.mimeType ||
            (metadata.orientation !== undefined && metadata.orientation !== 1) ||
            (metadata.pages !== undefined && metadata.pages !== 1) ||
            (metadata.pageHeight !== undefined && metadata.pageHeight !== metadata.height) ||
            !isDeepStrictEqual(size, expectedDeliverySize(options))
        )
            reject("增强交付上传实际元数据不符");
        const descriptor = { kind: "final" as const, sha256: hash.digest("hex"), bytes, mimeType: input.mimeType, ...size, resultId: options.resultId, resultIndex: options.resultIndex };
        const previous = (initial.resultPayload?.artifacts as StoredImageProcessingArtifact[] | undefined)?.[0];
        if (previous) {
            const { storageKey: _storageKey, ...observed } = previous;
            if (!isDeepStrictEqual(observed, descriptor)) reject("增强交付已有不同上传内容");
            const verified = await readVerifiedEnhancementArtifact(initial, previous);
            try {
                return await stageEnhancementProcessingArtifact(initial, identity, previous);
            } finally {
                await verified.dispose();
            }
        }
        const stored = await writeReferenceMediaFile(filename, "image", input.mimeType, false, {
            ownerUserId: initial.userId,
            source: "image-processing-final",
            taskId: initial.id,
            conversationId: initial.conversationId,
            maxBytes: options.budgets.delivery.maxBytes,
        });
        return await stageEnhancementProcessingArtifact(initial, identity, { ...descriptor, storageKey: stored.token });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

export async function resumeUnstartedEnhancementPublication(expected: ImageEnhancementJob) {
    const child = expected.publicationProcessing && (await readEnhancementProcessingTask(expected.publicationProcessing.jobId));
    if (!child) reject("增强从未启动检查点不存在");
    const facts = await readEnhancementProcessingFacts(child);
    return resumeUnstartedStore(expected, facts);
}

export async function cancelEnhancementPublication(expected: ImageEnhancementJob): Promise<ImageEnhancementJob | null> {
    const initial = expected.publicationProcessing && (await readEnhancementProcessingTask(expected.publicationProcessing.jobId));
    if (!initial) reject("增强处理检查点不存在");
    return mutateEnhancementRelation(enhancementRelationLocator(initial), enhancementRelationStorageKeys(initial), (state) => {
        const child = currentChild(initial, state.child);
        const parent = state.parent;
        if (!["queued", "running", "failed"].includes(parent.status) || parent.publication || (parent.cancelRequested && parent.status !== "failed")) return { result: null };
        if (
            parent.publicationProcessing?.jobId !== child.id ||
            parent.publicationProcessing.inputDigest !== child.payload.inputDigest ||
            parent.attempt !== child.payload.enhancementBinding.attempt ||
            parent.remoteKey !== child.payload.enhancementBinding.remoteKey ||
            parent.receiptId !== child.payload.enhancementBinding.receiptId
        )
            reject("增强取消检查点已变化");
        let nextChild = child;
        if (child.status === "pending" || (child.status === "paused" && child.payload.executionId === undefined))
            nextChild = { ...child, status: "cancelled", executionPhase: "completed", nextPollAt: undefined, workerId: undefined, leaseUntil: undefined, lastHeartbeatAt: undefined, updatedAt: state.now };
        else if (child.status === "running") nextChild = { ...child, status: "cancelled", executionPhase: "cancel_requested", nextPollAt: undefined, updatedAt: state.now };
        const nextParent: ImageEnhancementJob = { ...parent, status: "queued", cancelRequested: true, nextPollAt: state.now, updatedAt: state.now, events: [...parent.events, { stage: "cancel_requested", at: state.now, attempt: parent.attempt }] };
        return { child: nextChild, parent: nextParent, result: nextParent };
    });
}

export async function retryEnhancementPublication(expected: ImageEnhancementJob) {
    const child = expected.publicationProcessing && (await readEnhancementProcessingTask(expected.publicationProcessing.jobId));
    if (!child) reject("增强CPU检查点不存在");
    const facts = await readEnhancementProcessingFacts(child);
    return expected.publicationProcessing!.admission || (child.resultPayload?.admissionResume && !expected.publicationProcessing!.outcome) ? resumeUnstartedStore(expected, facts) : resumeClosedEnhancementPublication(expected, facts);
}
export async function closeEnhancementProcessingCancellation(
    initial: EnhancementProcessingTask,
    input: import("./image-processing-service").ImageProcessingCancellationInput,
): Promise<import("./image-processing-service").ImageProcessingCancellationCloseReceipt> {
    return mutateEnhancementRelation(enhancementRelationLocator(initial), enhancementRelationStorageKeys(initial), (state) => {
        const child = currentChild(initial, state.child);
        if (child.status !== "cancelled" || child.payload.executionId !== input.executionId) reject("增强取消关闭执行身份或状态冲突");
        const field = "notStarted" in input ? "cancelNotStarted" : "cancelClose";
        const other = "notStarted" in input ? "cancelClose" : "cancelNotStarted";
        const saved = child.resultPayload?.[field] as ({ receipt: import("./image-processing-service").ImageProcessingCancellationCloseReceipt } & Record<string, unknown>) | undefined;
        if (child.executionPhase === "completed") {
            if (!saved || child.resultPayload?.[other]) reject("增强取消关闭回执类型冲突");
            const { receipt, ...report } = saved;
            if (!isDeepStrictEqual(report, input)) reject("增强取消关闭回执身份或报告冲突");
            return { result: receipt };
        }
        if (child.executionPhase !== "cancel_requested" || child.workerId !== input.workerId || child.resultPayload?.cancelClose || child.resultPayload?.cancelNotStarted) reject("增强取消关闭执行所有者已变化");
        const receipt = { jobId: child.id, executionId: input.executionId, status: "cancelled" as const, executionPhase: "completed" as const };
        const next: EnhancementProcessingTask = {
            ...child,
            status: "cancelled",
            executionPhase: "completed",
            workerId: undefined,
            leaseUntil: undefined,
            lastHeartbeatAt: undefined,
            nextPollAt: undefined,
            updatedAt: state.now,
            resultPayload: { ...child.resultPayload, executionId: input.executionId, workerId: input.workerId, [field]: { ...input, receipt } },
        };
        return { child: next, result: receipt };
    });
}
