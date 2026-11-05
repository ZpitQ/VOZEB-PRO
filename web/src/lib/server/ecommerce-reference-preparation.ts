import { createHash } from "node:crypto";
import { originalImageSourceUrl } from "@/lib/media-image-url";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { fetchInternalApi } from "./internal-origin";
import { maintenanceWorkerContextHeaders } from "./maintenance-auth";
import type { AgentRun } from "./agent-run-store";
import { enqueueImageProcessingTask, hasOnlyCompletedEcommerceReferencePrepares, type StoredImageProcessingArtifact } from "./image-processing-service";
import { EcommerceReferenceSourceChangedError, EcommerceReferenceSourceReadError, referenceSourceTuple } from "./ecommerce-reference-recovery";
import { getCreativeAssetsByIds } from "./creative-runtime-store";
import { listStoredGenerationTaskRecordsByRunIds } from "./generation-task-store";

export type PreparedEcommerceReference = {
    assetId: string;
    contentSha256: string;
    sourceSize: { width: number; height: number };
    sourceUrl: string;
    sourceBytes: number;
    analysis: StoredImageProcessingArtifact;
};

export async function readCompletedEcommerceReference(run: AgentRun, assetId: string): Promise<PreparedEcommerceReference | undefined> {
    const current = run.ecommerceSnapshot?.referenceCheckpoint?.assets.find((item) => item.asset.id === assetId);
    const reference = run.ecommerceSnapshot?.processing?.prepareReferences.find((item) => item.assetId === assetId);
    if (!current || !reference?.manifest) return;
    const children = await listStoredGenerationTaskRecordsByRunIds([run.id], [run.userId]);
    if (!hasOnlyCompletedEcommerceReferencePrepares(run, children)) return;
    const assets = await getCreativeAssetsByIds([assetId], run.userId);
    const asset = assets.find((item) => item.id === assetId && item.userId === run.userId && item.conversationId === run.conversationId && item.type === "image" && item.status === "ready");
    if (!asset?.serverUrl || referenceSourceTuple(asset).some((value, index) => value !== referenceSourceTuple(current.asset)[index])) return;
    const source = reference.manifest.sourceIdentities[0];
    if (source.width === undefined || source.height === undefined) return;
    return {
        assetId,
        contentSha256: source.sha256,
        sourceSize: { width: source.width, height: source.height },
        sourceUrl: asset.serverUrl,
        sourceBytes: source.bytes,
        analysis: reference.manifest.artifacts[0],
    };
}

export async function prepareEcommerceReferences(run: AgentRun, executionId: string): Promise<PreparedEcommerceReference[] | undefined> {
    const snapshot = run.ecommerceSnapshot;
    if (!snapshot?.referenceCheckpoint) throw new Error("参考预处理检查点不存在");
    const checkpoint = snapshot.referenceCheckpoint;
    const prepared: PreparedEcommerceReference[] = [];
    for (const item of checkpoint.assets) {
        const stage = await enqueueImageProcessingTask({
            runId: run.id,
            parentExecutionId: executionId,
            algorithmVersion: "reference-input-policy.v1",
            operation: "prepare_reference",
            inputs: [{ assetId: item.asset.id, assetVersion: item.assetVersion, ...(item.contentSha256 ? { expectedSha256: item.contentSha256 } : {}) }],
            options: {},
        });
        // Enqueue owns the parent release; the next reference needs a new claim.
        if (stage.status !== "success") return;
        const manifest = snapshot.processing?.prepareReferences.find((reference) => reference.jobId === stage.id && reference.inputDigest === stage.payload.inputDigest)?.manifest;
        const source = manifest?.sourceIdentities[0];
        const analysis = manifest?.artifacts[0];
        if (
            !manifest ||
            manifest.jobId !== stage.id ||
            !source ||
            source.decodeError ||
            source.width === undefined ||
            source.height === undefined ||
            source.assetId !== item.asset.id ||
            source.sha256 !== item.contentSha256 ||
            !analysis ||
            analysis.kind !== "analysis"
        )
            throw new EcommerceReferenceSourceChangedError();
        const sourceUrl = item.asset.serverUrl;
        if (!sourceUrl) throw new EcommerceReferenceSourceChangedError();
        prepared.push({ assetId: item.asset.id, contentSha256: source.sha256, sourceSize: { width: source.width, height: source.height }, sourceUrl, sourceBytes: source.bytes, analysis });
    }
    return prepared;
}

export async function loadPreparedEcommerceReference(reference: PreparedEcommerceReference, origin: string, cookie: string) {
    const artifact = reference.analysis;
    const pathname = "/api/reference-assets/" + artifact.storageKey.split("/").map(encodeURIComponent).join("/");
    const source = await referenceStream(pathname, origin, cookie);
    const hash = createHash("sha256");
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of source) {
        bytes += chunk.byteLength;
        if (bytes > artifact.bytes) throw new EcommerceReferenceSourceChangedError();
        hash.update(chunk);
        chunks.push(Buffer.from(chunk));
    }
    if (bytes !== artifact.bytes || hash.digest("hex") !== artifact.sha256) throw new EcommerceReferenceSourceChangedError();
    return { url: "data:" + artifact.mimeType + ";base64," + Buffer.concat(chunks, bytes).toString("base64"), size: reference.sourceSize, contentSha256: reference.contentSha256 };
}

type PreparedEcommerceReferenceSource = Pick<PreparedEcommerceReference, "sourceUrl" | "sourceBytes" | "contentSha256">;

export async function verifyPreparedEcommerceReferenceSource(reference: PreparedEcommerceReferenceSource, origin: string, cookie: string) {
    for await (const chunk of verifiedPreparedEcommerceReferenceChunks(reference, origin, cookie)) void chunk;
}

export async function loadPreparedEcommerceReferenceSource(reference: PreparedEcommerceReferenceSource, origin: string, cookie: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of verifiedPreparedEcommerceReferenceChunks(reference, origin, cookie)) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks, reference.sourceBytes);
}

async function* verifiedPreparedEcommerceReferenceChunks(reference: PreparedEcommerceReferenceSource, origin: string, cookie: string) {
    const sourceUrl = new URL(originalImageSourceUrl(reference.sourceUrl), origin);
    const source = await referenceStream(sourceUrl.pathname + sourceUrl.search, origin, cookie);
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of source) {
        bytes += chunk.byteLength;
        if (bytes > reference.sourceBytes) throw new EcommerceReferenceSourceChangedError();
        hash.update(chunk);
        yield chunk;
    }
    if (bytes !== reference.sourceBytes || hash.digest("hex") !== reference.contentSha256) throw new EcommerceReferenceSourceChangedError();
}

async function referenceStream(pathname: string, origin: string, cookie: string): Promise<AsyncIterable<Uint8Array>> {
    const response = await fetchInternalApi(origin + pathname, { headers: maintenanceWorkerContextHeaders(cookie) || { cookie }, cache: "no-store" });
    if (!response.ok) {
        await response.body?.cancel();
        throw new EcommerceReferenceSourceReadError(response.status);
    }
    if (!response.body) throw new EcommerceReferenceSourceReadError(response.status);
    return Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>);
}
