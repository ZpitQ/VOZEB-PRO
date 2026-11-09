import { NextResponse } from "next/server";
import { readJsonBodyResult } from "@/lib/auth/request";
import type {
    ImageProcessingEnhancementBaseline,
    ImageProcessingEnhancementResult,
    ImageProcessingRectangle,
    ImageProcessingResult,
    ImageProcessingSize,
    ProductEnhancementEvidence,
    SceneEnhancementEvidence,
    SceneProtectionEvidence,
    SceneProtectionSnapshot,
} from "@/lib/image-processing/contracts";
import { completeImageProcessingTask, ImageProcessingInputError, type CompleteImageProcessingInput, type StoredImageProcessingArtifact } from "@/lib/server/image-processing-service";
import { isAuthorizedWorkerRequest, isWorkerTokenConfigured } from "@/lib/server/maintenance-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
    if (!isWorkerTokenConfigured()) return NextResponse.json({ code: 503, data: null, msg: "Worker 令牌未配置或未与维护令牌分离" }, { status: 503 });
    if (!isAuthorizedWorkerRequest(request)) return NextResponse.json({ code: 401, data: null, msg: "Worker 认证失败" }, { status: 401 });
    try {
        const parsed = await readJsonBodyResult<unknown>(request);
        if (!parsed.ok) return NextResponse.json({ code: parsed.status, data: null, msg: parsed.message }, { status: parsed.status });
        const input = completionInput(parsed.data);
        const { id } = await context.params;
        const data = await completeImageProcessingTask(id, input);
        return NextResponse.json({ code: 0, data, msg: "OK" }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
        if (error instanceof ImageProcessingInputError) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
        console.error("Image processing completion failed", error);
        return NextResponse.json({ code: 500, data: null, msg: "图像处理完成登记失败" }, { status: 500 });
    }
}

function completionInput(value: unknown): CompleteImageProcessingInput {
    const body = fields(value, ["workerId", "executionId", "manifest", "metrics"]);
    const manifest = fields(body.manifest, ["jobId", "executionId", "sourceIdentities", "artifacts", "geometry", "results", "enhancement"]);
    if (manifest.enhancement !== undefined) return enhancementCompletionInput(body, manifest);
    if (manifest.results !== undefined) return resultCompletionInput(body, manifest);
    if (!Array.isArray(manifest.sourceIdentities) || manifest.sourceIdentities.length !== 1 || !Array.isArray(manifest.artifacts) || ![1, 3].includes(manifest.artifacts.length))
        throw new ImageProcessingInputError("参考完成清单必须包含一份原件身份和完整工件", 400);
    const source = fields(manifest.sourceIdentities[0], ["assetId", "assetVersion", "sha256", "bytes", "mimeType", "width", "height"]);
    const artifact = fields(manifest.artifacts[0], ["kind", "storageKey", "sha256", "mimeType", "bytes", "width", "height"]);
    if (artifact.kind !== "analysis" && artifact.kind !== "mask" && artifact.kind !== "generation_reference") throw new ImageProcessingInputError("参考完成清单工件类别无效", 400);
    const artifacts = manifest.artifacts.map((value): StoredImageProcessingArtifact => {
        const item = fields(value, ["kind", "storageKey", "sha256", "mimeType", "bytes", "width", "height"]);
        if (item.kind !== "analysis" && item.kind !== "mask" && item.kind !== "generation_reference" && item.kind !== "generation_mask") throw new ImageProcessingInputError("参考完成清单工件类别无效", 400);
        return { kind: item.kind, storageKey: text(item.storageKey), sha256: sha256(item.sha256), mimeType: text(item.mimeType), bytes: integer(item.bytes), width: integer(item.width), height: integer(item.height) };
    });
    const geometry = geometryInput(manifest.geometry, artifact.kind);
    return {
        workerId: text(body.workerId).trim(),
        executionId: text(body.executionId),
        manifest: {
            jobId: text(manifest.jobId),
            executionId: text(manifest.executionId),
            sourceIdentities: [
                { assetId: text(source.assetId), assetVersion: text(source.assetVersion), sha256: sha256(source.sha256), bytes: integer(source.bytes), mimeType: text(source.mimeType), width: integer(source.width), height: integer(source.height) },
            ],
            artifacts,
            geometry,
        },
        metrics: completionMetrics(body.metrics),
    };
}

function enhancementCompletionInput(body: Record<string, unknown>, manifest: Record<string, unknown>): CompleteImageProcessingInput {
    if (manifest.results !== undefined || !Array.isArray(manifest.sourceIdentities) || !manifest.sourceIdentities.length || manifest.sourceIdentities.length > 6 || !Array.isArray(manifest.artifacts) || manifest.artifacts.length !== 1)
        throw new ImageProcessingInputError("Enhancement completion requires owned source identities and one final artifact without result slots", 400);
    const geometry = fields(manifest.geometry, ["sourceSize"]);
    const artifact = manifest.artifacts[0];
    fields(artifact, ["kind", "storageKey", "sha256", "mimeType", "bytes", "width", "height", "resultId", "resultIndex"]);
    const enhancement = enhancementResultInput(manifest.enhancement);
    if (enhancement.aiInputIndex >= manifest.sourceIdentities.length || enhancement.deliveredArtifactIndex !== 0) throw new ImageProcessingInputError("Enhancement completion role index is invalid", 400);
    return {
        workerId: text(body.workerId).trim(),
        executionId: text(body.executionId),
        manifest: {
            jobId: text(manifest.jobId),
            executionId: text(manifest.executionId),
            sourceIdentities: manifest.sourceIdentities.map((value) => {
                const source = fields(value, ["assetId", "assetVersion", "sha256", "bytes", "mimeType", "width", "height"]);
                return { assetId: text(source.assetId), assetVersion: text(source.assetVersion), sha256: sha256(source.sha256), bytes: integer(source.bytes), mimeType: text(source.mimeType), width: integer(source.width), height: integer(source.height) };
            }),
            artifacts: [resultArtifactInput(artifact)],
            geometry: { sourceSize: sizeInput(geometry.sourceSize) },
            enhancement,
        },
        metrics: completionMetrics(body.metrics),
    };
}

function enhancementResultInput(value: unknown): ImageProcessingEnhancementResult {
    const result = fields(value, ["version", "bindingDigest", "scope", "aiInputIndex", "ai", "deliveredArtifactIndex", "deliveryEncodingMs", "protection"]);
    if (result.version !== "enhancement-processing-result.v1" || (result.scope !== "full_image" && result.scope !== "product_background" && result.scope !== "local_edit"))
        throw new ImageProcessingInputError("Enhancement completion version or scope is invalid", 400);
    const ai = fields(result.ai, ["sha256", "byteLength", "width", "height", "format"]);
    if (ai.format !== "png") throw new ImageProcessingInputError("Enhancement qualified AI must be PNG", 400);
    const elapsed = result.deliveryEncodingMs;
    if (elapsed !== undefined && (typeof elapsed !== "number" || !Number.isFinite(elapsed) || elapsed < 0)) throw new ImageProcessingInputError("Enhancement encoding duration is invalid", 400);
    let protection: ImageProcessingEnhancementResult["protection"];
    if (result.scope === "full_image") {
        if (result.protection !== undefined) throw new ImageProcessingInputError("Global enhancement completion cannot contain protection evidence", 400);
    } else protection = result.scope === "product_background" ? productCompositionInput(result.protection) : sceneEnhancementEvidenceInput(result.protection);
    return {
        version: "enhancement-processing-result.v1",
        bindingDigest: sha256(result.bindingDigest),
        scope: result.scope,
        aiInputIndex: integer(result.aiInputIndex, 0),
        ai: { sha256: sha256(ai.sha256), byteLength: integer(ai.byteLength), width: integer(ai.width), height: integer(ai.height), format: "png" },
        deliveredArtifactIndex: integer(result.deliveredArtifactIndex, 0),
        ...(elapsed === undefined ? {} : { deliveryEncodingMs: elapsed }),
        ...(protection === undefined ? {} : { protection }),
    };
}

function sceneEnhancementEvidenceInput(value: unknown): SceneEnhancementEvidence {
    const proof = fields(value, ["version", "normalization", "sourceAssetId", "sourceSha256", "maskSha256", "aiSha256", "compositeSha256", "sourceSize", "aiSize", "allowedPixels", "protectedPixels", "protectedChangedPixels", "mapping"]);
    if (proof.version !== "scene-enhancement.v1" || proof.normalization !== "srgb-upright-v1" || proof.protectedChangedPixels !== 0) throw new ImageProcessingInputError("Scene enhancement completion evidence is invalid", 400);
    const mapping = fields(proof.mapping, ["context", "targetRegion"]);
    const context = rectangleInput(mapping.context);
    if (context.x !== 0 || context.y !== 0) throw new ImageProcessingInputError("Scene enhancement context origin is invalid", 400);
    return {
        version: "scene-enhancement.v1",
        normalization: "srgb-upright-v1",
        sourceAssetId: text(proof.sourceAssetId),
        sourceSha256: sha256(proof.sourceSha256),
        maskSha256: sha256(proof.maskSha256),
        aiSha256: sha256(proof.aiSha256),
        compositeSha256: sha256(proof.compositeSha256),
        sourceSize: sizeInput(proof.sourceSize),
        aiSize: sizeInput(proof.aiSize),
        allowedPixels: integer(proof.allowedPixels, 0),
        protectedPixels: integer(proof.protectedPixels, 0),
        protectedChangedPixels: 0,
        mapping: { context: { x: 0, y: 0, width: context.width, height: context.height }, targetRegion: rectangleInput(mapping.targetRegion) },
    };
}

function completionMetrics(value: unknown): CompleteImageProcessingInput["metrics"] {
    const metrics = fields(value, ["pid", "peakRssBytes", "peakHeapUsedBytes", "peakExternalBytes", "elapsedMs"]);
    const elapsedMs = metrics.elapsedMs;
    if (typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs) || elapsedMs < 0) throw new ImageProcessingInputError("子进程耗时无效", 400);
    return { pid: integer(metrics.pid), peakRssBytes: integer(metrics.peakRssBytes, 0), peakHeapUsedBytes: integer(metrics.peakHeapUsedBytes, 0), peakExternalBytes: integer(metrics.peakExternalBytes, 0), elapsedMs };
}

function resultCompletionInput(body: Record<string, unknown>, manifest: Record<string, unknown>): CompleteImageProcessingInput {
    if (!Array.isArray(manifest.sourceIdentities) || !manifest.sourceIdentities.length || !Array.isArray(manifest.artifacts) || !manifest.artifacts.length || !Array.isArray(manifest.results) || !manifest.results.length)
        throw new ImageProcessingInputError("结果完成清单必须包含原件身份、结果工件和槽位", 400);
    const geometry = fields(manifest.geometry, ["sourceSize"]);
    return {
        workerId: text(body.workerId).trim(),
        executionId: text(body.executionId),
        manifest: {
            jobId: text(manifest.jobId),
            executionId: text(manifest.executionId),
            sourceIdentities: manifest.sourceIdentities.map(resultSourceInput),
            artifacts: manifest.artifacts.map(resultArtifactInput),
            results: manifest.results.map(resultBindingInput),
            geometry: geometry.sourceSize === undefined ? {} : { sourceSize: sizeInput(geometry.sourceSize) },
        },
        metrics: completionMetrics(body.metrics),
    };
}

function resultSourceInput(value: unknown): ImageProcessingResult["sourceIdentities"][number] {
    const source = fields(value, ["assetId", "assetVersion", "sha256", "bytes", "mimeType", "width", "height", "decodeError", "nativeImage"]);
    const identity = { assetId: text(source.assetId), assetVersion: text(source.assetVersion), sha256: sha256(source.sha256), bytes: integer(source.bytes) };
    if (source.decodeError !== undefined) {
        fields(value, ["assetId", "assetVersion", "sha256", "bytes", "decodeError"]);
        const error = fields(source.decodeError, ["code", "message"]);
        return { ...identity, decodeError: { code: text(error.code), message: text(error.message) } };
    }
    const decoded = { ...identity, mimeType: text(source.mimeType), width: integer(source.width), height: integer(source.height) };
    if (source.nativeImage === undefined) return decoded;
    const nativeImage = fields(source.nativeImage, ["format", "hasAlpha"]);
    if (typeof nativeImage.hasAlpha !== "boolean") throw new ImageProcessingInputError("结果原件透明像素事实无效", 400);
    return { ...decoded, nativeImage: { format: text(nativeImage.format), hasAlpha: nativeImage.hasAlpha } };
}

function resultArtifactInput(value: unknown): CompleteImageProcessingInput["manifest"]["artifacts"][number] {
    const artifact = fields(value, ["kind", "storageKey", "sha256", "mimeType", "bytes", "width", "height", "resultId", "resultIndex", "layerKind"]);
    if (artifact.kind !== "final") throw new ImageProcessingInputError("结果完成清单工件类别无效", 400);
    const layerKind = artifact.layerKind;
    if (layerKind !== undefined && layerKind !== "element" && layerKind !== "background") throw new ImageProcessingInputError("结果图层类别无效", 400);
    return {
        kind: "final",
        storageKey: text(artifact.storageKey),
        sha256: sha256(artifact.sha256),
        mimeType: text(artifact.mimeType),
        bytes: integer(artifact.bytes),
        width: integer(artifact.width),
        height: integer(artifact.height),
        resultId: text(artifact.resultId),
        resultIndex: integer(artifact.resultIndex),
        ...(layerKind === undefined ? {} : { layerKind }),
    };
}

function resultBindingInput(value: unknown): NonNullable<ImageProcessingResult["results"]>[number] {
    const result = fields(value, ["resultId", "resultIndex", "nativeInputIndex", "finalArtifactIndex", "error", "finalImage", "baselineValidated", "sceneProtectionEvidence", "productEnhancementEvidence"]);
    const identity = { resultId: text(result.resultId), resultIndex: integer(result.resultIndex), nativeInputIndex: integer(result.nativeInputIndex, 0) };
    if (result.error !== undefined) {
        fields(value, ["resultId", "resultIndex", "nativeInputIndex", "error"]);
        const error = fields(result.error, ["code", "message", "failureStage"]);
        if (error.failureStage !== "decode" && error.failureStage !== "validation") throw new ImageProcessingInputError("结果失败槽位阶段无效", 400);
        return { ...identity, error: { code: text(error.code), message: text(error.message), failureStage: error.failureStage } };
    }
    let finalImage: { format: string; hasAlpha: boolean } | undefined;
    if (result.finalImage !== undefined) {
        const image = fields(result.finalImage, ["format", "hasAlpha"]);
        if (typeof image.hasAlpha !== "boolean") throw new ImageProcessingInputError("最终成图透明事实无效", 400);
        finalImage = { format: text(image.format), hasAlpha: image.hasAlpha };
    }
    const baselineValidated = result.baselineValidated;
    if (baselineValidated !== undefined && typeof baselineValidated !== "boolean") throw new ImageProcessingInputError("结果基线验证标记无效", 400);
    return {
        ...identity,
        finalArtifactIndex: integer(result.finalArtifactIndex, 0),
        ...(finalImage ? { finalImage } : {}),
        ...(baselineValidated === undefined ? {} : { baselineValidated }),
        ...(result.sceneProtectionEvidence === undefined ? {} : { sceneProtectionEvidence: sceneResultEvidenceInput(result.sceneProtectionEvidence) }),
        ...(result.productEnhancementEvidence === undefined ? {} : { productEnhancementEvidence: productCompositionInput(result.productEnhancementEvidence) }),
    };
}

function sceneResultEvidenceInput(value: unknown): SceneProtectionEvidence {
    const proof = fields(value, [
        "version",
        "sourceAssetId",
        "sourceSize",
        "sourceDigest",
        "maskSize",
        "maskDigest",
        "targetRegion",
        "semantics",
        "selectionSource",
        "maskSemantics",
        "method",
        "confirmation",
        "nativeSize",
        "normalization",
        "nativeDigest",
        "compositeDigest",
        "outsidePixels",
        "mappedOutsideChangedPixels",
        "nativeOutsideChangedPixels",
        "compositeOutsideChangedPixels",
    ]);
    const { confirmation, nativeSize, normalization, nativeDigest, compositeDigest, outsidePixels, mappedOutsideChangedPixels, nativeOutsideChangedPixels, compositeOutsideChangedPixels, ...snapshot } = proof;
    if ((normalization !== "none" && normalization !== "uniform_scale" && normalization !== "pixel_grid_scale") || compositeOutsideChangedPixels !== 0) throw new ImageProcessingInputError("场景结果保护证据结构无效", 400);
    const confirmed = confirmation === undefined ? undefined : fields(confirmation, ["actorUserId", "confirmedAt"]);
    return {
        ...sceneProtectionInput(snapshot),
        ...(confirmed === undefined ? {} : { confirmation: { actorUserId: text(confirmed.actorUserId), confirmedAt: integer(confirmed.confirmedAt, 0) } }),
        nativeSize: sizeInput(nativeSize),
        normalization,
        nativeDigest: sha256(nativeDigest),
        compositeDigest: sha256(compositeDigest),
        outsidePixels: integer(outsidePixels, 0),
        mappedOutsideChangedPixels: integer(mappedOutsideChangedPixels, 0),
        ...(nativeOutsideChangedPixels === undefined ? {} : { nativeOutsideChangedPixels: integer(nativeOutsideChangedPixels, 0) }),
        compositeOutsideChangedPixels: 0,
    };
}

function geometryInput(value: unknown, kind: "analysis" | "mask" | "generation_reference"): ImageProcessingResult["geometry"] {
    const geometry = fields(value, kind === "mask" ? ["sourceSize", "productBounds", "haloBounds", "sceneProtection", "enhancementBaseline"] : ["sourceSize"]);
    return {
        sourceSize: sizeInput(geometry.sourceSize),
        ...(geometry.productBounds !== undefined ? { productBounds: rectangleInput(geometry.productBounds) } : {}),
        ...(geometry.haloBounds !== undefined ? { haloBounds: rectangleInput(geometry.haloBounds) } : {}),
        ...(geometry.sceneProtection !== undefined ? { sceneProtection: sceneProtectionInput(geometry.sceneProtection) } : {}),
        ...(geometry.enhancementBaseline !== undefined ? { enhancementBaseline: enhancementBaselineInput(geometry.enhancementBaseline) } : {}),
    };
}

function sizeInput(value: unknown): ImageProcessingSize {
    const size = fields(value, ["width", "height"]);
    return { width: integer(size.width), height: integer(size.height) };
}

function rectangleInput(value: unknown): ImageProcessingRectangle {
    const rectangle = fields(value, ["x", "y", "width", "height"]);
    return { x: integer(rectangle.x, 0), y: integer(rectangle.y, 0), width: integer(rectangle.width), height: integer(rectangle.height) };
}

function sceneProtectionInput(value: unknown): SceneProtectionSnapshot {
    const protection = fields(value, ["version", "sourceAssetId", "sourceSize", "sourceDigest", "maskSize", "maskDigest", "targetRegion", "semantics", "selectionSource", "maskSemantics", "method"]);
    if (
        protection.version !== "scene-edit-protection.v1" ||
        protection.selectionSource !== "user_selection" ||
        protection.maskSemantics !== "alpha_zero_edit" ||
        protection.method !== "source_pixels_copy" ||
        !Array.isArray(protection.semantics) ||
        !protection.semantics.length
    )
        throw new ImageProcessingInputError("场景保护快照结构或语义无效", 400);
    return {
        version: "scene-edit-protection.v1",
        sourceAssetId: text(protection.sourceAssetId),
        sourceSize: sizeInput(protection.sourceSize),
        sourceDigest: sha256(protection.sourceDigest),
        maskSize: sizeInput(protection.maskSize),
        maskDigest: sha256(protection.maskDigest),
        targetRegion: rectangleInput(protection.targetRegion),
        semantics: protection.semantics.map(text),
        selectionSource: "user_selection",
        maskSemantics: "alpha_zero_edit",
        method: "source_pixels_copy",
    };
}

function enhancementBaselineInput(value: unknown): ImageProcessingEnhancementBaseline {
    const baseline = fields(value, ["status", "scope", "normalization", "baseline", "hasAlpha", "composition", "error"]);
    if (baseline.scope !== "local_edit" && baseline.scope !== "product_background") throw new ImageProcessingInputError("增强基线范围无效", 400);
    if (baseline.status === "unsupported") {
        fields(value, ["status", "scope", "error"]);
        const error = fields(baseline.error, ["code", "message"]);
        return { status: "unsupported", scope: baseline.scope, error: { code: text(error.code), message: text(error.message) } };
    }
    if (baseline.status !== "qualified" || baseline.normalization !== "srgb-upright-v1" || typeof baseline.hasAlpha !== "boolean") throw new ImageProcessingInputError("增强基线资格结构无效", 400);
    fields(value, ["status", "scope", "normalization", "baseline", "hasAlpha", "composition"]);
    const frozen = fields(baseline.baseline, ["sha256", "byteLength", "width", "height", "normalizedSha256"]);
    return {
        status: "qualified",
        scope: baseline.scope,
        normalization: "srgb-upright-v1",
        hasAlpha: baseline.hasAlpha,
        baseline: { sha256: sha256(frozen.sha256), byteLength: integer(frozen.byteLength), width: integer(frozen.width), height: integer(frozen.height), normalizedSha256: sha256(frozen.normalizedSha256) },
        ...(baseline.composition !== undefined ? { composition: productCompositionInput(baseline.composition) } : {}),
    };
}

function productCompositionInput(value: unknown): ProductEnhancementEvidence {
    const evidence = fields(value, ["version", "normalization", "productAnchorId", "sourceAssetId", "sourceSha256", "maskSha256", "aiSha256", "compositeSha256", "sourceSize", "aiSize", "allowedPixels", "protectedPixels", "protectedChangedPixels"]);
    if (evidence.version !== "product-enhancement.v2" || evidence.normalization !== "srgb-upright-v1" || evidence.protectedChangedPixels !== 0) throw new ImageProcessingInputError("商品增强合成证据结构无效", 400);
    return {
        version: "product-enhancement.v2",
        normalization: "srgb-upright-v1",
        productAnchorId: text(evidence.productAnchorId),
        sourceAssetId: text(evidence.sourceAssetId),
        sourceSha256: sha256(evidence.sourceSha256),
        maskSha256: sha256(evidence.maskSha256),
        aiSha256: sha256(evidence.aiSha256),
        compositeSha256: sha256(evidence.compositeSha256),
        sourceSize: sizeInput(evidence.sourceSize),
        aiSize: sizeInput(evidence.aiSize),
        allowedPixels: integer(evidence.allowedPixels, 0),
        protectedPixels: integer(evidence.protectedPixels, 0),
        protectedChangedPixels: 0,
    };
}

function fields(value: unknown, allowed: string[]): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new ImageProcessingInputError("完成请求含未知字段或结构无效", 400);
    return value as Record<string, unknown>;
}

function text(value: unknown): string {
    if (typeof value !== "string" || !value.trim()) throw new ImageProcessingInputError("完成请求身份字段无效", 400);
    return value;
}

function sha256(value: unknown): string {
    const hash = text(value);
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new ImageProcessingInputError("完成请求摘要无效", 400);
    return hash;
}

function integer(value: unknown, minimum = 1): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new ImageProcessingInputError("完成请求尺寸或资源数值无效", 400);
    return value;
}
