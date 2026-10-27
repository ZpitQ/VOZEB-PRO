import type { ImageTaskMediaResult, ImageTaskResult } from "@/app/api/image-tasks/image-task-types";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { directRemoteImageResult, imageReferenceToDataUrl, inlineRemoteImageResult, resolveProxiedMediaSource } from "@/app/api/image-tasks/image-task-support";
import { canvasProviderDimensions, parseImageDimensions, resolveResultSize } from "@/app/api/image-tasks/image-task-size";
import { dedupeImageResults } from "@/lib/image-result-dedupe";
import { isCustomGeminiImageModel } from "@/lib/server/custom-gemini-image-model";
import { generationModelId, systemGenerationChannelId } from "@/lib/server/generation-channel";
import { generationMediaProxyHeaders } from "@/lib/server/generation-media-authorization";
import { deleteLocalAsset, normalizeAssets } from "@/lib/server/generation-log-repository";
import { validateImageLayerOutputs } from "@/lib/server/image-layer-output";
import type { ImageTask, ImageTaskResultEvidence, StoredImageTaskMediaResult } from "@/lib/server/image-task-store";
import { assertTransparentImageOutput } from "@/lib/server/image-transparent-output";
import { decodeEcommerceCanvasSize } from "@/lib/server/ecommerce-generation-service";
import { compositeSceneEdit } from "./ecommerce-product-regions";
import { ecommerceSceneProtectionReferencesMatch } from "./ecommerce-image-task-orchestration";
import { imageEnhancementExclusion, type EnhancementSource } from "./image-enhancement-plan";
import { compositeProductEnhancement } from "./image-enhancement-product-protection";
import { localEnhancementContractMatches } from "./image-enhancement-delivery";

export type PreparedImageTaskResults = { results: StoredImageTaskMediaResult[]; batchEvidence?: ImageTaskResultEvidence[] };

export async function prepareImageTaskResults(task: ImageTask, result: ImageTaskResult, origin: string, authContext: string): Promise<PreparedImageTaskResults> {
    const preserveLayers = task.config.outputMode === "layers";
    const productDelivery = hasSupportedEnhancementDelivery(task) && task.enhancementDelivery?.scope === "product_background";
    const preserveResults = preserveLayers || Boolean(task.ecommerceExecution?.canvas || task.sceneProtection || productDelivery);
    const settled = await Promise.allSettled(imageTaskMediaResults(result, preserveResults).map((item) => normalizeSafeImageResult(task, item, origin, authContext)));
    if (task.ecommerceExecution?.canvas && !preserveLayers && !task.sceneProtection && !productDelivery) return persistCanvasBatch(task, settled, origin, authContext);
    if (productDelivery) return persistProductEnhancementResults(task, settled, origin, authContext);
    const normalized = settled.flatMap((item) => (item.status === "fulfilled" && item.value?.dataUrl ? [item.value] : []));
    let safeResults = preserveResults ? normalized : dedupeImageResults(normalized);

    if (preserveLayers) {
        const rejected = firstRejected(settled);
        if (rejected) throw new Error(`上游分层验收失败：${errorMessage(rejected, "上游分层图片无法读取")}，请为该模型配置真实分层接口`);
    }
    if (!safeResults.length) throw firstRejected(settled) || new Error("上游返回的图片文件无效或保存失败");
    if (task.sceneProtection && firstRejected(settled)) throw firstRejected(settled);
    if (task.sceneProtection) return { results: await persistSceneProtectionResults(task, safeResults, origin, authContext) };

    if (task.config.outputBackground === "transparent") {
        const validated = await Promise.allSettled(safeResults.map(async (item) => (await assertTransparentImageOutput(item.dataUrl), item)));
        safeResults = validated.flatMap((item) => (item.status === "fulfilled" ? [item.value] : []));
        if (!safeResults.length) throw firstRejected(validated) || new Error("上游没有生成有效透明图层");
    }

    if (preserveLayers) {
        if (task.kind !== "edit" || task.references.length !== 1) throw new Error("上游分层验收失败：电商分层需要且只能使用一张源图，请为该模型配置真实分层接口");
        try {
            const source = await imageReferenceToDataUrl(task.references[0], task.references[0].name || "source.png", origin, authContext);
            const validated = await validateImageLayerOutputs(
                source,
                safeResults.map((item) => item.dataUrl),
            );
            safeResults = validated.map((output, index) => ({ ...safeResults[index], ...output, remoteUrl: undefined }));
        } catch (error) {
            throw new Error(`上游分层验收失败：${errorMessage(error, "上游分层结果无法验证")}，请为该模型配置真实分层接口`);
        }
    }

    return { results: await persistPreparedResults(task, safeResults, preserveLayers) };
}

async function persistCanvasBatch(task: ImageTask, normalized: PromiseSettledResult<ImageTaskMediaResult>[], origin: string, authContext: string): Promise<PreparedImageTaskResults> {
    const canvas = task.ecommerceExecution!.canvas!;
    const batchEvidence: ImageTaskResultEvidence[] = normalized.map((_, index) => ({ resultId: `${task.id}:${index + 1}`, resultIndex: index + 1, nativeStatus: "unavailable", storageStatus: "unavailable" }));
    const prepared = await Promise.all(
        normalized.map(async (item, index): Promise<StoredImageTaskMediaResult | null> => {
            const evidence = batchEvidence[index];
            if (item.status === "rejected") {
                Object.assign(evidence, { failureStage: "read", failureReason: "上游原生图片无法读取" });
                return null;
            }
            try {
                evidence.nativeSize = await decodeEcommerceCanvasSize(Buffer.from(item.value.dataUrl.split(",")[1], "base64"));
                evidence.nativeStatus = "readable";
            } catch {
                Object.assign(evidence, { failureStage: "decode", failureReason: "上游原生图片无法解码" });
                return null;
            }
            if (task.config.outputBackground === "transparent") {
                try {
                    await assertTransparentImageOutput(item.value.dataUrl);
                } catch {
                    Object.assign(evidence, { failureStage: "validation", failureReason: "上游图片透明背景验收失败" });
                    return null;
                }
            }
            let written: string | undefined;
            try {
                const [asset] = await normalizeAssets([{ type: "image", url: item.value.dataUrl, remoteUrl: item.value.remoteUrl }], {
                    ownerUserId: task.userId,
                    source: task.source,
                    conversationId: task.conversationId,
                    taskId: task.id,
                    originalName: `${task.title || task.prompt.slice(0, 80) || "图片生成"}-${index + 1}`,
                });
                if (!asset?.serverUrl) throw new Error("原生图片保存失败");
                written = asset.serverUrl;
                const native = hasSupportedEnhancementDelivery(task) && requests4k(task) ? { ...(await inspectStoredImage(asset.serverUrl, origin, authContext)), provenance: "provider_native" as const } : undefined;
                const storedSize = native ? { width: native.width, height: native.height } : { width: asset.width!, height: asset.height! };
                const skip = taskEnhancementExclusion(task);
                evidence.storageStatus = "stored";
                evidence.storedUrl = asset.serverUrl;
                if (storedSize.width && storedSize.height) evidence.storedSize = storedSize;
                return {
                    resultId: evidence.resultId,
                    ...(native ? { nativeSource: native, enhancementId: `enhancement:${evidence.resultId}` } : {}),
                    ...(skip ? { enhancementSkip: skip } : {}),
                    dataUrl: asset.serverUrl,
                    remoteUrl: asset.remoteUrl,
                    serverUrl: asset.serverUrl,
                    width: storedSize.width,
                    height: storedSize.height,
                    bytes: asset.bytes,
                    mimeType: asset.mimeType,
                    canvasEvidence: {
                        constraint: structuredClone(canvas),
                        ...(task.ecommerceCanvasRequest ? { providerRequest: { ...task.ecommerceCanvasRequest }, requestedSize: canvasProviderDimensions(task.ecommerceCanvasRequest) } : {}),
                        nativeSize: evidence.nativeSize,
                        storedSize,
                        nativeUrl: asset.serverUrl,
                        normalization: "none",
                    },
                };
            } catch {
                if (written) await deleteLocalAsset(written).catch(() => undefined);
                Object.assign(evidence, { failureStage: "store", failureReason: "原生图片保存失败" });
                return null;
            }
        }),
    );
    return { results: prepared.filter((item): item is StoredImageTaskMediaResult => item !== null), batchEvidence };
}

export function persistedImageTaskResults(task: ImageTask): StoredImageTaskMediaResult[] {
    const values = task.result?.results?.length ? task.result.results : task.result ? [task.result] : [];
    if (!values.length || values.some((item) => !isStableServerResult(item))) return [];
    return values;
}

export function deletePreparedImageTaskResults(results: StoredImageTaskMediaResult[]) {
    return Promise.allSettled(
        [...new Set(results.flatMap((item) => [item.serverUrl || item.dataUrl, item.sceneProtectionEvidence?.maskUrl, item.sceneProtectionEvidence?.nativeUrl, item.productEnhancementEvidence?.nativeUrl].filter((url): url is string => Boolean(url))))].map(
            (url) => deleteLocalAsset(url),
        ),
    );
}

async function persistProductEnhancementResults(task: ImageTask, results: PromiseSettledResult<ImageTaskMediaResult>[], origin: string, authContext: string): Promise<PreparedImageTaskResults> {
    const delivery = task.enhancementDelivery;
    if (delivery?.version !== "ecommerce-delivery.v2" || delivery.scope !== "product_background") throw new Error("商品保护增强缺少冻结交付快照");
    const size = delivery.protection.product.sourceSize;
    const maxPixels = size.width * size.height;
    if (![size.width, size.height, maxPixels].every((value) => Number.isSafeInteger(value) && value > 0)) throw new Error("商品保护源图尺寸无效");
    const source = await storedImageBytes(delivery.baseline.url, origin, authContext);
    if (source.length !== delivery.baseline.byteLength || imageDigest(source) !== delivery.baseline.sha256) throw new Error("商品保护源图与冻结摘要不一致");
    const normalized = await sharp(source, { failOn: "warning", limitInputPixels: maxPixels }).rotate().toColourspace("srgb").ensureAlpha().png().toBuffer({ resolveWithObject: true });
    if (normalized.info.width !== size.width || normalized.info.height !== size.height || delivery.baseline.width !== size.width || delivery.baseline.height !== size.height || imageDigest(normalized.data) !== delivery.baseline.normalizedSha256)
        throw new Error("商品保护源图与冻结展示基线不一致");
    const context = { ownerUserId: task.userId, source: task.source, conversationId: task.conversationId, taskId: task.id };
    const batchEvidence: ImageTaskResultEvidence[] = results.map((_, index) => ({ resultId: `${task.id}:${index + 1}`, resultIndex: index + 1, nativeStatus: "unavailable", storageStatus: "unavailable" }));
    const stored: StoredImageTaskMediaResult[] = [];
    const failures: unknown[] = [];
    for (let index = 0; index < results.length; index++) {
        const item = results[index];
        const evidence = batchEvidence[index];
        if (item.status === "rejected") {
            Object.assign(evidence, { failureStage: "read", failureReason: "上游原生图片无法读取" });
            failures.push(item.reason);
            continue;
        }
        const written: string[] = [];
        const save = async (url: string, originalName: string) => {
            const [asset] = await normalizeAssets([{ type: "image", url }], { ...context, originalName });
            if (!asset?.serverUrl) throw new Error("商品保护结果保存失败");
            written.push(asset.serverUrl);
            return asset;
        };
        let stage: "decode" | "validation" | "store" = "decode";
        try {
            const bytes = Buffer.from(item.value.dataUrl.split(",")[1], "base64");
            const nativeSize = await decodeEcommerceCanvasSize(bytes);
            evidence.nativeSize = nativeSize;
            evidence.nativeStatus = "readable";
            stage = "validation";
            if (nativeSize.width !== size.width || nativeSize.height !== size.height) throw new Error("商品保护上游原生尺寸必须与冻结源图完全一致");
            const composed = await compositeProductEnhancement(source, bytes, delivery.protection, maxPixels, "native");
            stage = "store";
            const native = await save(item.value.dataUrl, `product-edit-native-${index + 1}.png`);
            const nativeInfo = await inspectStoredImage(native.serverUrl!, origin, authContext);
            const composite = await save(`data:image/png;base64,${composed.bytes.toString("base64")}`, `product-edit-base-${index + 1}.png`);
            const compositeInfo = await inspectStoredImage(composite.serverUrl!, origin, authContext);
            const composition = composed.evidence;
            if (
                nativeInfo.sha256 !== composition.aiSha256 ||
                nativeInfo.width !== size.width ||
                nativeInfo.height !== size.height ||
                compositeInfo.format !== "png" ||
                compositeInfo.sha256 !== composition.compositeSha256 ||
                compositeInfo.width !== size.width ||
                compositeInfo.height !== size.height
            )
                throw new Error("商品保护持久文件与真实合成证据不一致");
            const resultId = `${task.id}:${index + 1}`;
            const skip = taskEnhancementExclusion(task);
            const canvas = task.ecommerceExecution?.canvas;
            Object.assign(evidence, { storageStatus: "stored", storedUrl: composite.serverUrl, storedSize: { width: compositeInfo.width, height: compositeInfo.height } });
            stored.push({
                resultId,
                ...(requests4k(task) ? { nativeSource: { ...nativeInfo, provenance: "provider_native" }, enhancementId: `enhancement:${resultId}` } : {}),
                ...(skip ? { enhancementSkip: skip } : {}),
                dataUrl: composite.serverUrl!,
                serverUrl: composite.serverUrl,
                width: compositeInfo.width,
                height: compositeInfo.height,
                bytes: compositeInfo.byteLength,
                mimeType: "image/png",
                productEnhancementEvidence: { version: "product-baseline.v2", nativeUrl: native.serverUrl!, nativeSha256: nativeInfo.sha256, baselineUrl: composite.serverUrl!, baselineSha256: compositeInfo.sha256, composition },
                ...(canvas
                    ? {
                          canvasEvidence: {
                              constraint: structuredClone(canvas),
                              ...(task.ecommerceCanvasRequest ? { providerRequest: { ...task.ecommerceCanvasRequest }, requestedSize: canvasProviderDimensions(task.ecommerceCanvasRequest) } : {}),
                              nativeSize: { width: nativeInfo.width, height: nativeInfo.height },
                              storedSize: { width: compositeInfo.width, height: compositeInfo.height },
                              nativeUrl: native.serverUrl!,
                              normalization: "none",
                          },
                      }
                    : {}),
            });
        } catch (error) {
            await Promise.allSettled(written.map((url) => deleteLocalAsset(url)));
            Object.assign(evidence, { failureStage: stage, failureReason: stage === "decode" ? "上游原生图片无法解码" : stage === "validation" ? "商品保护原生图片或合成校验失败" : "商品保护结果保存失败" });
            failures.push(error);
        }
    }
    if (!stored.length && !task.ecommerceExecution?.canvas) throw failures[0] || new Error("商品保护没有合格结果");
    return { results: stored, batchEvidence };
}

async function storedImageBytes(url: string, origin: string, authContext: string) {
    const value = await imageReferenceToDataUrl({ dataUrl: url }, "original.png", origin, authContext);
    if (!value.startsWith("data:image/")) throw new Error("持久图片原件无法读取");
    return Buffer.from(value.split(",")[1], "base64");
}

async function inspectStoredImage(url: string, origin: string, authContext: string): Promise<Omit<EnhancementSource, "provenance">> {
    const bytes = await storedImageBytes(url, origin, authContext);
    const image = sharp(bytes, { failOn: "warning" });
    const metadata = await image.metadata();
    if (!metadata.format || (metadata.pages && metadata.pages !== 1)) throw new Error("持久图片不是有效单帧原件");
    const decoded = await image.rotate().toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let hasAlpha = false;
    for (let offset = 3; offset < decoded.data.length; offset += 4)
        if (decoded.data[offset] !== 255) {
            hasAlpha = true;
            break;
        }
    return { url, sha256: imageDigest(bytes), byteLength: bytes.length, width: decoded.info.width, height: decoded.info.height, format: metadata.format, hasAlpha };
}

function imageDigest(bytes: Buffer) {
    return createHash("sha256").update(bytes).digest("hex");
}

async function persistSceneProtectionResults(task: ImageTask, results: ImageTaskMediaResult[], origin: string, authContext: string): Promise<StoredImageTaskMediaResult[]> {
    const protection = task.sceneProtection!;
    const reference = task.references.find((item) => item.id === protection.sourceAssetId);
    if (task.kind !== "edit" || !ecommerceSceneProtectionReferencesMatch(protection.sourceAssetId, task.references, task.ecommerceExecution) || !reference || task.mask?.dataUrl !== protection.mask.dataUrl)
        throw new Error("局部场景缺少完整原图与独立蒙版");
    const source = Buffer.from((await imageReferenceToDataUrl(reference, "scene.png", origin, authContext)).split(",")[1], "base64");
    // Validate source, mask and native aspect before any save; retain native bytes separately from the protected delivery.
    const composites = await Promise.all(results.map((item) => compositeSceneEdit(source, Buffer.from(item.dataUrl.split(",")[1], "base64"), protection)));
    const contract = task.enhancementDelivery;
    let localDelivery = requests4k(task) && contract?.scope === "local_edit" && hasSupportedEnhancementDelivery(task) && source.length === contract.baseline.byteLength && imageDigest(source) === contract.baseline.sha256;
    if (localDelivery && contract?.scope === "local_edit") {
        const normalized = await sharp(source, { failOn: "warning" }).rotate().toColourspace("srgb").ensureAlpha().png().toBuffer({ resolveWithObject: true });
        localDelivery = normalized.info.width === contract.baseline.width && normalized.info.height === contract.baseline.height && imageDigest(normalized.data) === contract.baseline.normalizedSha256;
    }
    const context = { ownerUserId: task.userId, source: task.source, conversationId: task.conversationId, taskId: task.id };
    const stored: StoredImageTaskMediaResult[] = [];
    const written: string[] = [];
    const save = async (url: string, originalName: string) => {
        const [asset] = await normalizeAssets([{ type: "image", url }], { ...context, originalName });
        if (!asset?.serverUrl) throw new Error("场景保护证据保存失败");
        written.push(asset.serverUrl);
        return asset;
    };
    try {
        const mask = await save(protection.mask.dataUrl, "scene-edit-mask.png");
        for (let index = 0; index < results.length; index++) {
            const native = await save(results[index].dataUrl, `scene-edit-native-${index + 1}.png`);
            const composite = await save("data:image/png;base64," + composites[index].bytes.toString("base64"), `scene-edit-composite-${index + 1}.png`);
            const nativeInfo = localDelivery ? await inspectStoredImage(native.serverUrl!, origin, authContext) : undefined;
            const compositeInfo = localDelivery ? await inspectStoredImage(composite.serverUrl!, origin, authContext) : undefined;
            const candidate = nativeInfo && compositeInfo && nativeInfo.sha256 === composites[index].evidence.nativeDigest && compositeInfo.sha256 === composites[index].evidence.compositeDigest && compositeInfo.format === "png" && !compositeInfo.hasAlpha;
            const canvas = task.ecommerceExecution?.canvas;
            stored.push({
                resultId: `${task.id}:${index + 1}`,
                ...(candidate ? { nativeSource: { ...nativeInfo!, provenance: "provider_native" as const }, enhancementId: `enhancement:${task.id}:${index + 1}` } : { enhancementSkip: taskEnhancementExclusion(task) }),
                dataUrl: composite.serverUrl!,
                serverUrl: composite.serverUrl,
                width: composite.width,
                height: composite.height,
                bytes: composite.bytes,
                mimeType: composite.mimeType,
                ...(canvas
                    ? {
                          canvasEvidence: {
                              constraint: structuredClone(canvas),
                              ...(task.ecommerceCanvasRequest ? { providerRequest: { ...task.ecommerceCanvasRequest }, requestedSize: canvasProviderDimensions(task.ecommerceCanvasRequest) } : {}),
                              nativeSize: { width: nativeInfo?.width ?? native.width!, height: nativeInfo?.height ?? native.height! },
                              storedSize: { width: composite.width!, height: composite.height! },
                              nativeUrl: native.serverUrl!,
                              normalization: composites[index].evidence.normalization,
                          },
                      }
                    : {}),
                sceneProtectionEvidence: { ...composites[index].evidence, maskUrl: mask.serverUrl!, nativeUrl: native.serverUrl!, compositeUrl: composite.serverUrl! },
            });
        }
        return stored;
    } catch (error) {
        await Promise.allSettled(written.map((url) => deleteLocalAsset(url)));
        throw error;
    }
}

async function persistPreparedResults(task: ImageTask, results: ImageTaskMediaResult[], requireAll: boolean) {
    const canvas = task.ecommerceExecution?.canvas;
    const nativeSizes = canvas ? await Promise.all(results.map((item) => decodeEcommerceCanvasSize(Buffer.from(item.dataUrl.split(",")[1], "base64")))) : [];
    const preserveNative4k = requests4k(task) && !canvas && !requireAll;
    const requested4k = preserveNative4k && !hasUnsupportedEnhancementProtection(task);
    const preserveNativeSize = preserveNative4k || (task.config.advancedConfig?.protocol === "custom" && isCustomGeminiImageModel(task.config.model) && !parseImageDimensions(task.config.size || ""));
    const targetSize = canvas || task.config.outputMode === "layers" || preserveNativeSize ? undefined : resolveResultSize(task.config.quality, task.config.size || "auto");
    const settled = await Promise.allSettled(
        results.map(async (item, index) => {
            if (requested4k && !item.dataUrl.startsWith("data:image/")) throw new Error("上游原图无法读取并冻结");
            const bytes = requested4k ? Buffer.from(item.dataUrl.split(",")[1], "base64") : undefined;
            const metadata = bytes ? await sharp(bytes).metadata() : undefined;
            const native =
                bytes && metadata
                    ? { sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length, format: metadata.format!, hasAlpha: metadata.hasAlpha ? !(await sharp(bytes).stats()).isOpaque : false, provenance: "provider_native" as const }
                    : undefined;
            const assets = await normalizeAssets([{ type: "image", url: item.dataUrl, remoteUrl: item.remoteUrl, targetSize }], {
                ownerUserId: task.userId,
                source: task.source,
                conversationId: task.conversationId,
                taskId: task.id,
                originalName: `${task.title || task.prompt.slice(0, 80) || "图片生成"}-${index + 1}`,
            });
            return { assets, native };
        }),
    );
    const stored = settled
        .flatMap((item, index) => (item.status === "fulfilled" ? item.value.assets.map((asset) => ({ asset, nativeSize: nativeSizes[index], native: item.value.native, resultId: `${task.id}:${index + 1}` })) : []))
        .map(({ asset, nativeSize, native, resultId }) => ({
            resultId,
            dataUrl: asset.serverUrl || asset.url,
            remoteUrl: asset.remoteUrl,
            serverUrl: asset.serverUrl,
            width: asset.width,
            height: asset.height,
            bytes: asset.bytes,
            mimeType: asset.mimeType,
            ...(native ? { enhancementId: `enhancement:${resultId}`, nativeSource: { ...native, url: asset.serverUrl || asset.url, width: asset.width!, height: asset.height! } } : { enhancementSkip: taskEnhancementExclusion(task) }),
            ...(canvas
                ? {
                      canvasEvidence: {
                          constraint: { ...canvas, size: { ...canvas.size } },
                          ...(task.ecommerceCanvasRequest ? { providerRequest: { ...task.ecommerceCanvasRequest }, requestedSize: canvasProviderDimensions(task.ecommerceCanvasRequest) } : {}),
                          nativeSize,
                          storedSize: { width: asset.width!, height: asset.height! },
                          nativeUrl: asset.serverUrl || asset.url,
                          normalization: "none" as const,
                      },
                  }
                : {}),
        }));
    if (requireAll && stored.length !== results.length) {
        await deletePreparedImageTaskResults(stored);
        throw firstRejected(settled) || new Error("上游分层图片保存失败");
    }
    if (!stored.length) throw firstRejected(settled) || new Error("生成图片保存到服务器失败");
    return stored;
}

function imageTaskMediaResults(result: ImageTaskResult, preserveDuplicates: boolean): ImageTaskMediaResult[] {
    const values = result.results?.length ? result.results : result.dataUrl || result.remoteUrl ? [{ dataUrl: result.dataUrl, remoteUrl: result.remoteUrl }] : [];
    return preserveDuplicates ? values : dedupeImageResults(values);
}

async function normalizeSafeImageResult(task: ImageTask, result: ImageTaskMediaResult, origin: string, authContext: string): Promise<ImageTaskMediaResult> {
    const remoteUrl = typeof result.remoteUrl === "string" ? result.remoteUrl : undefined;
    const proxiedMedia = resolveProxiedMediaSource(result.dataUrl || "", origin);
    const proxiedRemoteUrl = proxiedMedia.remoteUrl;
    const channelId = task.config.channelId || systemGenerationChannelId(task.config.baseUrl);
    const mediaHeaders = proxiedRemoteUrl && channelId ? generationMediaProxyHeaders({ userId: task.userId, taskType: "image", taskId: task.id, channelId, upstreamModel: generationModelId(task.config), url: proxiedRemoteUrl }) : undefined;
    const inlineResult = proxiedMedia.proxyUrl ? await inlineRemoteImageResult(result.dataUrl, origin, authContext, remoteUrl, mediaHeaders) : null;
    if (proxiedMedia.proxyUrl && !inlineResult?.dataUrl?.startsWith("data:image/")) throw new Error("上游图片无法通过授权媒体路径读取");
    if (task.config.outputMode === "layers" || task.ecommerceExecution?.canvas || task.sceneProtection || task.enhancementDelivery?.scope === "product_background" || requests4k(task)) {
        const readable = inlineResult || (await inlineRemoteImageResult(result.dataUrl || remoteUrl || "", origin, authContext, remoteUrl, mediaHeaders));
        if (!readable?.dataUrl?.startsWith("data:image/")) throw new Error("上游原生图片无法读取并验收");
        return readable;
    }
    return inlineResult || directRemoteImageResult(remoteUrl) || (await inlineRemoteImageResult(result.dataUrl, origin, authContext, remoteUrl, mediaHeaders));
}

function requests4k(task: ImageTask) {
    return resolveResultSize(task.config.quality, "1:1") === resolveResultSize("4k", "1:1");
}

function taskEnhancementExclusion(task: ImageTask) {
    return imageEnhancementExclusion({
        enabled: task.enhancementPolicy?.enabled ?? false,
        requested4k: requests4k(task),
        protectedContract: hasUnsupportedEnhancementProtection(task),
        layered: task.config.outputMode === "layers",
    });
}

function hasSupportedEnhancementDelivery(task: ImageTask) {
    const delivery = task.enhancementDelivery;
    const protection = task.ecommerceExecution?.protection;
    if (delivery?.version !== "ecommerce-delivery.v2" || task.config.outputMode === "layers" || task.config.outputBackground === "transparent") return false;
    if (delivery.scope === "local_edit") return localEnhancementContractMatches(task, delivery);
    if (task.sceneProtection || (protection && (protection.scope !== "global" || protection.preserveOutsideMask))) return false;
    return (
        delivery.scope === "product_background" ||
        (delivery.scope === "full_image" && !task.productProtection && !task.mask && !task.ecommerceExecution?.mask && (!protection || (Array.isArray(protection.protectedObjectIds) && !protection.protectedObjectIds.length)))
    );
}

function hasUnsupportedEnhancementProtection(task: ImageTask) {
    const protection = task.ecommerceExecution?.protection;
    return (
        Boolean(
            task.ecommerceExecution?.canvas ||
            task.sceneProtection ||
            task.productProtection ||
            task.mask ||
            task.ecommerceExecution?.mask ||
            (protection && (protection.scope !== "global" || protection.preserveOutsideMask || protection.protectedObjectIds?.length)),
        ) && !hasSupportedEnhancementDelivery(task)
    );
}

function isStableServerResult(result: StoredImageTaskMediaResult) {
    const value = result.serverUrl || result.dataUrl;
    return value.startsWith("/api/generation-log-assets/") || value.startsWith("/api/reference-assets/");
}

function firstRejected(results: PromiseSettledResult<unknown>[]) {
    return results.find((item): item is PromiseRejectedResult => item.status === "rejected")?.reason;
}

function errorMessage(error: unknown, fallback: string) {
    return error instanceof Error ? error.message : fallback;
}
