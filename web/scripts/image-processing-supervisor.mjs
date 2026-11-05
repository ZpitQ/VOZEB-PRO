import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const childEntry = fileURLToPath(new URL("../.image-processing-runtime/workers/image-processing-child.mjs", import.meta.url));

/**
 * @param {import("../src/lib/image-processing/contracts.js").ImageProcessingRequest} request
 * @param {{taskDirectory:string,maxHeapMiB:number,signal?:AbortSignal}} execution
 * @returns {Promise<import("../src/lib/image-processing/contracts.js").ImageProcessingOutcome>}
 */
export async function runImageProcessing(request, execution) {
    validateRequest(request);
    if (!Number.isSafeInteger(execution.maxHeapMiB) || execution.maxHeapMiB <= 0) throw new TypeError("子进程堆预算必须为正整数MiB");
    const taskDirectory = realpathSync(execution.taskDirectory);
    const outputDirectory = controlledPath(taskDirectory, request.outputDirectory);
    if (!statSync(outputDirectory).isDirectory()) throw new TypeError("输出路径必须是任务目录中的目录");
    const inputs = request.inputs.map((input) => {
        const inputPath = controlledPath(taskDirectory, input.path);
        if (!statSync(inputPath).isFile()) throw new TypeError("输入路径必须是任务目录中的文件");
        return { ...input, path: inputPath };
    });
    const controlledRequest = { ...request, outputDirectory, inputs };
    const unstarted = { jobId: request.jobId, executionId: request.executionId, pid: null, exitCode: null, signal: null, stderr: "" };
    if (execution.signal?.aborted) return { status: "aborted", ...unstarted };

    const environment = { NODE_ENV: "production", UV_THREADPOOL_SIZE: "2" };
    for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "TZ"]) {
        if (process.env[key] !== undefined) environment[key] = process.env[key];
    }
    const child = fork(childEntry, [], { execArgv: [`--max-old-space-size=${execution.maxHeapMiB}`], env: environment, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    return new Promise((resolve) => {
        let reply;
        let failure;
        let protocolFailure;
        let aborted = false;
        let stderr = "";
        const abort = () => {
            aborted = true;
            child.kill("SIGTERM");
        };
        execution.signal?.addEventListener("abort", abort, { once: true });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });
        child.on("message", (message) => {
            const identity = message?.status === "completed" ? message.result : message;
            if (reply || !identity || identity.jobId !== request.jobId || identity.executionId !== request.executionId || !["completed", "rejected"].includes(message.status)) {
                protocolFailure = "子进程返回了不属于本次任务身份或重复的结果";
                child.kill("SIGTERM");
                return;
            }
            reply = message;
        });
        child.on("error", (error) => {
            failure = error;
        });
        child.on("close", async (exitCode, signal) => {
            execution.signal?.removeEventListener("abort", abort);
            const evidence = { jobId: request.jobId, executionId: request.executionId, pid: child.pid ?? null, exitCode, signal, stderr };
            if (aborted) return resolve({ status: "aborted", ...evidence });
            if (failure) return resolve({ status: "crashed", error: { code: "child_process_error", message: failure.message }, ...evidence });
            if (protocolFailure) return resolve({ status: "crashed", error: { code: "invalid_child_result", message: protocolFailure }, ...evidence });
            if (exitCode !== 0) {
                // SIGKILL alone also occurs during cancellation and external termination; it proves no OOM.
                if (/(?:FATAL ERROR:[^\r\n]*(?:heap out of memory|Reached heap limit|Ineffective mark-compacts)|^# Fatal JavaScript out of memory:)/im.test(stderr)) return resolve({ status: "resource_failure", reason: "v8_heap_oom", ...evidence });
                return resolve({ status: "crashed", error: { code: "unexpected_exit", message: "图像子进程未正常退出" }, ...evidence });
            }
            if (!reply) return resolve({ status: "crashed", error: { code: "missing_child_result", message: "图像子进程退出但未返回结果" }, ...evidence });
            try {
                if (reply.status === "completed") await validateResult(reply.result, controlledRequest, taskDirectory, child.pid);
                else if (!reply.error || typeof reply.error.code !== "string" || typeof reply.error.message !== "string") throw new Error("子进程拒绝结果无效");
                resolve({ ...reply, ...evidence });
            } catch (error) {
                resolve({ status: "crashed", error: { code: "invalid_child_result", message: error.message }, ...evidence });
            }
        });
        child.send(controlledRequest, (error) => {
            if (error) {
                failure = error;
                child.kill("SIGTERM");
            }
        });
    });
}

function validateRequest(request) {
    if (!request || request.version !== "image-processing.v1" || typeof request.jobId !== "string" || !request.jobId || typeof request.executionId !== "string" || !request.executionId) throw new TypeError("图像任务身份或版本无效");
    if (!Array.isArray(request.inputs) || !request.inputs.length || (request.operation !== "process_result" && request.operation !== "process_enhancement" && request.inputs.length !== 1)) throw new TypeError("图像操作输入数量无效");
    for (const input of request.inputs) {
        if (!input || typeof input.assetId !== "string" || !input.assetId || typeof input.assetVersion !== "string" || !input.assetVersion) throw new TypeError("输入素材身份无效");
        if (input.expectedSha256 !== undefined && (typeof input.expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedSha256))) throw new TypeError("冻结图片hash无效");
    }
    if (!request.options || typeof request.options !== "object" || Array.isArray(request.options)) throw new TypeError("图像操作参数无效");
    if (request.operation === "prepare_reference") {
        if (Object.keys(request.options).length !== 0) throw new TypeError("参考预处理不接受额外操作参数");
    } else if (request.operation === "prepare_review") {
        const region = request.options.region;
        if (
            Object.keys(request.options).some((key) => key !== "region") ||
            (region !== undefined &&
                (!region ||
                    typeof region !== "object" ||
                    Array.isArray(region) ||
                    Object.keys(region).some((key) => !["x", "y", "width", "height"].includes(key)) ||
                    ![region.x, region.y, region.width, region.height].every(Number.isSafeInteger) ||
                    region.x < 0 ||
                    region.y < 0 ||
                    region.width <= 0 ||
                    region.height <= 0))
        )
            throw new TypeError("视觉取证仅接受原像素整数选区");
    } else if (request.operation === "build_protection") {
        if (request.options.mode === "local_edit") {
            if (!rectangle(request.options.targetRegion) || !Array.isArray(request.options.protectedRectangles) || !request.options.protectedRectangles.every(rectangle)) throw new TypeError("局部商品保护参数无效");
            const freeze = request.options.freezeEnhancementBaseline;
            if (freeze !== undefined && (!freeze || typeof freeze.productAnchorId !== "string" || !freeze.productAnchorId.trim() || !Array.isArray(freeze.productCore) || !freeze.productCore.length || !freeze.productCore.every(rectangle)))
                throw new TypeError("商品基线资格需要真实商品锚点与core");
        } else if (request.options.mode === "scene_selection") {
            if (
                !rectangle(request.options.region) ||
                request.options.selectionSource !== "user_selection" ||
                !Array.isArray(request.options.semantics) ||
                !request.options.semantics.length ||
                request.options.semantics.some((value) => typeof value !== "string" || !value.trim())
            )
                throw new TypeError("场景选区参数无效");
            if (request.options.freezeEnhancementBaseline !== undefined && request.options.freezeEnhancementBaseline !== true) throw new TypeError("场景基线资格标记无效");
        } else if (
            typeof request.options.transparentBackground !== "boolean" ||
            Object.keys(request.options).some((key) => !["transparentBackground", "freezeEnhancementBaseline"].includes(key)) ||
            (request.options.freezeEnhancementBaseline !== undefined && request.options.freezeEnhancementBaseline !== true)
        )
            throw new TypeError("商品保护需要透明背景判别参数");
    } else if (request.operation === "process_enhancement") {
        validateEnhancementRequest(request);
    } else if (request.operation === "process_result") {
        const { mode, results, targetSize, transparentBackground } = request.options;
        if (!["ordinary", "layers", "scene_protection", "product_protection"].includes(mode) || (mode === "ordinary" && typeof transparentBackground !== "boolean") || !Array.isArray(results) || !results.length) throw new TypeError("结果处理参数无效");
        for (const result of results) {
            if (!result || typeof result.resultId !== "string" || !result.resultId || !positiveInteger(result.resultIndex) || !Number.isSafeInteger(result.inputIndex) || result.inputIndex < 0 || result.inputIndex >= request.inputs.length)
                throw new TypeError("结果槽位身份无效");
        }
        if (new Set(results.map((result) => result.resultId)).size !== results.length || new Set(results.map((result) => result.resultIndex)).size !== results.length) throw new TypeError("结果槽位身份重复");
        if (targetSize !== undefined && (!positiveInteger(targetSize.width) || !positiveInteger(targetSize.height))) throw new TypeError("目标尺寸无效");
        if (mode !== "ordinary" && (!Number.isSafeInteger(request.options.sourceInputIndex) || request.options.sourceInputIndex < 0 || request.options.sourceInputIndex >= request.inputs.length)) throw new TypeError("结果源图索引无效");
        if (
            ["scene_protection", "product_protection"].includes(mode) &&
            (!Number.isSafeInteger(request.options.maskInputIndex) || request.options.maskInputIndex < 0 || request.options.maskInputIndex >= request.inputs.length || !request.options.protection || typeof request.options.protection !== "object")
        )
            throw new TypeError("独立蒙版或保护快照无效");
        const referenced = new Set(results.map((result) => result.inputIndex));
        if (mode !== "ordinary") referenced.add(request.options.sourceInputIndex);
        if (["scene_protection", "product_protection"].includes(mode)) {
            referenced.add(request.options.maskInputIndex);
            const protection = request.options.protection;
            if (mode === "scene_protection") {
                if (
                    protection.version !== "scene-edit-protection.v1" ||
                    !size(protection.sourceSize) ||
                    !size(protection.maskSize) ||
                    !rectangle(protection.targetRegion) ||
                    !sha256(protection.sourceDigest) ||
                    !sha256(protection.maskDigest) ||
                    typeof protection.sourceAssetId !== "string" ||
                    !Array.isArray(protection.semantics) ||
                    protection.semantics.some((value) => typeof value !== "string") ||
                    protection.selectionSource !== "user_selection" ||
                    protection.maskSemantics !== "alpha_zero_edit" ||
                    protection.method !== "source_pixels_copy"
                )
                    throw new TypeError("场景保护快照无效");
            } else {
                const product = protection.product;
                if (
                    protection.version !== "product-enhancement.v2" ||
                    protection.normalization !== "srgb-upright-v1" ||
                    !sha256(protection.maskSha256) ||
                    !product ||
                    product.compilerVersion !== "strict-product.v1" ||
                    !["ready", "needs_review"].includes(product.state) ||
                    typeof product.sourceAssetId !== "string" ||
                    typeof product.productAnchorId !== "string" ||
                    !size(product.sourceSize) ||
                    ![product.productCore, product.fusionHalo, product.editableBackground].every((rectangles) => Array.isArray(rectangles) && rectangles.every(rectangle))
                )
                    throw new TypeError("商品保护快照无效");
            }
            const baseline = request.options.baseline;
            if ((mode === "product_protection" && baseline === undefined) || (baseline !== undefined && (!size(baseline) || !positiveInteger(baseline.byteLength) || !sha256(baseline.sha256) || !sha256(baseline.normalizedSha256))))
                throw new TypeError("冻结展示基线无效");
        }
        if (referenced.size !== request.inputs.length) throw new TypeError("图像输入必须全部绑定当前操作");
    } else throw new TypeError("图像操作无效");
}

function rectangle(value) {
    return value && [value.x, value.y, value.width, value.height].every(Number.isFinite) && value.x >= 0 && value.y >= 0 && value.width > 0 && value.height > 0;
}

function controlledPath(directory, candidate) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate)) throw new TypeError("图像路径必须位于受控任务目录");
    const resolved = realpathSync(candidate);
    const relative = path.relative(directory, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new TypeError("图像路径必须位于受控任务目录");
    return resolved;
}

async function validateResult(result, request, taskDirectory, pid) {
    if (request.operation !== "process_enhancement" && result.enhancement !== undefined) throw new Error("Enhancement receipt belongs only to enhancement processing");
    const count = request.operation === "process_result" ? request.options.results.length : 1;
    if (
        !Array.isArray(result.sourceIdentities) ||
        result.sourceIdentities.length !== request.inputs.length ||
        !Array.isArray(result.artifacts) ||
        !result.artifacts.length ||
        result.artifacts.length > count ||
        (request.operation !== "process_result" && result.artifacts.length !== 1)
    )
        throw new Error("子进程工件或源图身份无效");
    for (const [index, source] of result.sourceIdentities.entries()) {
        const input = request.inputs[index];
        if (source.assetId !== input.assetId || source.assetVersion !== input.assetVersion || !/^[a-f0-9]{64}$/.test(source.sha256) || (input.expectedSha256 !== undefined && source.sha256 !== input.expectedSha256)) throw new Error("子进程源图身份不匹配");
        if (!positiveInteger(source.bytes)) throw new Error("子进程源图元数据无效");
        if (source.decodeError !== undefined) {
            if (
                request.operation !== "process_result" ||
                request.options.mode === "layers" ||
                (request.options.mode !== "ordinary" && [request.options.sourceInputIndex, request.options.maskInputIndex].includes(index)) ||
                !failure(source.decodeError) ||
                source.width !== undefined ||
                source.height !== undefined ||
                source.mimeType !== undefined
            )
                throw new Error("子进程失败输入身份无效");
        } else if (!positiveInteger(source.width) || !positiveInteger(source.height) || typeof source.mimeType !== "string") throw new Error("子进程源图元数据无效");
        const native = request.operation === "process_result" && request.options.results.some((slot) => slot.inputIndex === index);
        if (native && source.decodeError === undefined) {
            const image = source.nativeImage;
            if (!image || image.format !== source.mimeType.slice("image/".length) || typeof image.hasAlpha !== "boolean" || Object.keys(image).some((key) => !["format", "hasAlpha"].includes(key))) throw new Error("子进程原生图像事实无效");
        } else if (source.nativeImage !== undefined) throw new Error("非原生结果输入不得包含原生图像事实");
        if (statSync(input.path).size !== source.bytes || (await fileDigest(input.path)) !== source.sha256) throw new Error("子进程源图文件与身份不匹配");
    }
    if (!result.geometry || typeof result.geometry !== "object") throw new Error("子进程几何无效");
    const ordinary = request.operation === "process_result" && request.options.mode === "ordinary";
    const source =
        result.sourceIdentities[
            request.operation === "process_enhancement"
                ? request.options.scope === "full_image"
                    ? request.options.aiInputIndex
                    : request.options.sourceInputIndex
                : request.operation === "process_result" && !ordinary
                  ? request.options.sourceInputIndex
                  : 0
        ];
    if (!ordinary || result.geometry.sourceSize !== undefined) {
        if (source.decodeError || result.geometry.sourceSize?.width !== source.width || result.geometry.sourceSize?.height !== source.height) throw new Error("子进程源图几何不匹配");
    }
    const artifactPaths = new Set();
    for (const artifact of result.artifacts) {
        if (
            artifact.kind !== (request.operation === "prepare_reference" || request.operation === "prepare_review" ? "analysis" : request.operation === "build_protection" ? "mask" : "final") ||
            !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
            !positiveInteger(artifact.width) ||
            !positiveInteger(artifact.height) ||
            !positiveInteger(artifact.bytes) ||
            typeof artifact.mimeType !== "string"
        )
            throw new Error("子进程工件元数据无效");
        const artifactPath = controlledPath(taskDirectory, artifact.path);
        controlledPath(request.outputDirectory, artifactPath);
        if (artifactPaths.has(artifactPath)) throw new Error("子进程工件路径重复");
        artifactPaths.add(artifactPath);
        const file = statSync(artifactPath);
        if (!file.isFile() || file.size !== artifact.bytes || (await fileDigest(artifactPath)) !== artifact.sha256) throw new Error("子进程工件文件不匹配");
    }
    if (request.operation === "prepare_review") {
        const artifact = result.artifacts[0];
        if (
            source.bytes > 20 * 1024 * 1024 ||
            source.width * source.height > 64_000_000 ||
            Object.keys(source).some((key) => !["assetId", "assetVersion", "sha256", "bytes", "mimeType", "width", "height"].includes(key)) ||
            Object.keys(result.geometry).some((key) => key !== "sourceSize") ||
            Object.keys(artifact).some((key) => !["kind", "path", "sha256", "mimeType", "bytes", "width", "height"].includes(key)) ||
            !["image/png", "image/jpeg"].includes(artifact.mimeType) ||
            artifact.bytes > 4 * 1024 * 1024 ||
            Math.max(artifact.width, artifact.height) > 2048
        )
            throw new Error("视觉取证工件或原图几何超出契约");
    }
    if (request.operation === "build_protection") {
        const qualification = result.geometry.enhancementBaseline;
        if (request.options.freezeEnhancementBaseline === undefined) {
            if (qualification !== undefined) throw new Error("未请求增强基线资格");
        } else {
            const scope = request.options.mode === "scene_selection" ? "local_edit" : "product_background";
            if (!qualification || qualification.scope !== scope) throw new Error("增强基线资格范围无效");
            if (qualification.status === "unsupported") {
                if (!failure(qualification.error) || qualification.baseline !== undefined) throw new Error("增强基线不适用证据无效");
            } else if (qualification.status === "qualified") {
                const baseline = qualification.baseline;
                if (
                    qualification.normalization !== "srgb-upright-v1" ||
                    typeof qualification.hasAlpha !== "boolean" ||
                    !baseline ||
                    baseline.sha256 !== source.sha256 ||
                    baseline.byteLength !== source.bytes ||
                    baseline.width !== source.width ||
                    baseline.height !== source.height ||
                    !sha256(baseline.normalizedSha256)
                )
                    throw new Error("增强基线资格与真实源图不匹配");
                if (scope === "product_background") {
                    const proof = qualification.composition;
                    const anchor = request.options.mode === "local_edit" ? request.options.freezeEnhancementBaseline.productAnchorId : request.inputs[0].assetId;
                    if (
                        qualification.hasAlpha ||
                        !proof ||
                        proof.productAnchorId !== anchor ||
                        proof.sourceAssetId !== source.assetId ||
                        proof.sourceSha256 !== source.sha256 ||
                        proof.maskSha256 !== result.artifacts[0].sha256 ||
                        proof.aiSha256 !== baseline.normalizedSha256 ||
                        proof.protectedChangedPixels !== 0 ||
                        proof.sourceSize?.width !== source.width ||
                        proof.sourceSize?.height !== source.height ||
                        !sha256(proof.compositeSha256)
                    )
                        throw new Error("商品增强基线缺少真实自合成证据");
                }
            } else throw new Error("增强基线资格状态无效");
        }
    }
    if (request.operation === "process_result") {
        if (!Array.isArray(result.results) || result.results.length !== count) throw new Error("结果槽位绑定数量无效");
        const assigned = new Set();
        for (const [index, binding] of result.results.entries()) {
            const slot = request.options.results[index];
            if (binding.resultId !== slot.resultId || binding.resultIndex !== slot.resultIndex || binding.nativeInputIndex !== slot.inputIndex) throw new Error("结果槽位与原生身份不匹配");
            const native = result.sourceIdentities[binding.nativeInputIndex];
            if (binding.error !== undefined) {
                if (
                    request.options.mode === "layers" ||
                    !failure(binding.error) ||
                    !["decode", "validation"].includes(binding.error.failureStage) ||
                    binding.finalArtifactIndex !== undefined ||
                    (native.decodeError !== undefined && (binding.error.failureStage !== "decode" || binding.error.code !== native.decodeError.code || binding.error.message !== native.decodeError.message))
                )
                    throw new Error("结果槽位失败证据无效");
                continue;
            }
            if (native.decodeError !== undefined || !Number.isSafeInteger(binding.finalArtifactIndex) || assigned.has(binding.finalArtifactIndex)) throw new Error("结果槽位与原生身份不匹配");
            const artifact = result.artifacts[binding.finalArtifactIndex];
            if (!artifact || artifact.resultId !== slot.resultId || artifact.resultIndex !== slot.resultIndex) throw new Error("结果工件与槽位不匹配");
            if (request.options.mode === "scene_protection") {
                const proof = binding.sceneProtectionEvidence;
                const original = result.sourceIdentities[request.options.sourceInputIndex];
                const mask = result.sourceIdentities[request.options.maskInputIndex];
                if (
                    !proof ||
                    proof.sourceDigest !== original.sha256 ||
                    proof.maskDigest !== mask.sha256 ||
                    proof.nativeDigest !== native.sha256 ||
                    proof.compositeDigest !== artifact.sha256 ||
                    !["none", "uniform_scale", "pixel_grid_scale"].includes(proof.normalization) ||
                    proof.nativeSize?.width !== native.width ||
                    proof.nativeSize?.height !== native.height ||
                    proof.sourceSize?.width !== original.width ||
                    proof.sourceSize?.height !== original.height ||
                    proof.compositeOutsideChangedPixels !== 0 ||
                    (request.options.baseline !== undefined && binding.baselineValidated !== true)
                )
                    throw new Error("场景结果证据与原生及合成工件不匹配");
            } else if (request.options.mode === "product_protection") {
                const proof = binding.productEnhancementEvidence;
                const original = result.sourceIdentities[request.options.sourceInputIndex];
                const mask = result.sourceIdentities[request.options.maskInputIndex];
                if (
                    !proof ||
                    proof.version !== "product-enhancement.v2" ||
                    proof.normalization !== "srgb-upright-v1" ||
                    proof.sourceSha256 !== original.sha256 ||
                    proof.maskSha256 !== mask.sha256 ||
                    proof.aiSha256 !== native.sha256 ||
                    proof.compositeSha256 !== artifact.sha256 ||
                    proof.sourceSize?.width !== original.width ||
                    proof.sourceSize?.height !== original.height ||
                    proof.aiSize?.width !== native.width ||
                    proof.aiSize?.height !== native.height ||
                    proof.protectedChangedPixels !== 0 ||
                    binding.baselineValidated !== true
                )
                    throw new Error("商品结果证据与原生及合成工件不匹配");
            } else if (request.options.mode === "layers" && !["element", "background"].includes(artifact.layerKind)) throw new Error("分层工件类别无效");
            assigned.add(binding.finalArtifactIndex);
        }
        if (assigned.size !== result.artifacts.length) throw new Error("成功结果与最终工件不一一对应");
    } else if (request.operation === "process_enhancement") {
        validateEnhancementResult(result, request);
    } else if (result.results !== undefined || result.enhancement !== undefined || result.artifacts.some((artifact) => artifact.resultId !== undefined || artifact.resultIndex !== undefined)) throw new Error("非结果操作不接受结果槽位绑定");
    const metrics = result.metrics;
    if (!metrics || metrics.pid !== pid || !positiveInteger(metrics.peakRssBytes) || !positiveInteger(metrics.peakHeapUsedBytes) || !positiveInteger(metrics.peakExternalBytes) || !Number.isFinite(metrics.elapsedMs) || metrics.elapsedMs < 0)
        throw new Error("子进程指标无效");
}

async function fileDigest(file) {
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(file)) digest.update(chunk);
    return digest.digest("hex");
}

function positiveInteger(value) {
    return Number.isSafeInteger(value) && value > 0;
}

function size(value) {
    return value && positiveInteger(value.width) && positiveInteger(value.height);
}
function sha256(value) {
    return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function failure(value) {
    return value && typeof value.code === "string" && value.code.length > 0 && typeof value.message === "string" && value.message.length > 0;
}

function validateEnhancementRequest(request) {
    const options = request.options;
    const common = ["scope", "bindingDigest", "resultId", "resultIndex", "aiInputIndex", "engineInput", "expectedAi", "targetSize", "budgets", "stagedDelivered"];
    const protectedFields = ["sourceInputIndex", "nativeInputIndex", "baselineInputIndex", "maskInputIndex", "source", "native", "baseline", "protection", "originalProof"];
    const full = options.scope === "full_image";
    if (
        !["full_image", "product_background", "local_edit"].includes(options.scope) ||
        Object.keys(options).some((key) => !common.includes(key) && (full || !protectedFields.includes(key))) ||
        !sha256(options.bindingDigest) ||
        typeof options.resultId !== "string" ||
        !options.resultId ||
        !positiveInteger(options.resultIndex) ||
        !size(options.engineInput) ||
        !size(options.targetSize)
    )
        throw new TypeError("Enhancement operation options are invalid");
    const role = (index) => Number.isSafeInteger(index) && index >= 0 && index < request.inputs.length;
    const artifact = (value) => value && size(value) && positiveInteger(value.byteLength) && sha256(value.sha256) && ["png", "jpeg"].includes(value.format);
    if (!role(options.aiInputIndex) || !artifact(options.expectedAi) || options.expectedAi.format !== "png" || options.expectedAi.width !== options.engineInput.width * 4 || options.expectedAi.height !== options.engineInput.height * 4)
        throw new TypeError("Enhancement AI identity is invalid");
    for (const kind of ["input", "ai", "delivery"]) if (!options.budgets?.[kind] || !positiveInteger(options.budgets[kind].maxBytes) || !positiveInteger(options.budgets[kind].maxPixels)) throw new TypeError("Enhancement budgets are invalid");
    if (request.inputs.some((input) => !sha256(input.expectedSha256)) || request.inputs[options.aiInputIndex].expectedSha256 !== options.expectedAi.sha256) throw new TypeError("Enhancement inputs require their frozen hashes");
    const roles = new Set([options.aiInputIndex]);
    const staged = options.stagedDelivered;
    if (staged !== undefined) {
        if (
            !staged ||
            Object.keys(staged).some((key) => !["inputIndex", "expected"].includes(key)) ||
            !role(staged.inputIndex) ||
            !artifact(staged.expected) ||
            staged.expected.sha256 !== request.inputs[staged.inputIndex].expectedSha256 ||
            (!full && staged.expected.format !== "png")
        )
            throw new TypeError("Staged enhancement delivery is invalid");
        roles.add(staged.inputIndex);
    }
    if (!full) {
        for (const field of ["sourceInputIndex", "nativeInputIndex", "baselineInputIndex", "maskInputIndex"]) {
            if (!role(options[field])) throw new TypeError("Protected enhancement input role is invalid");
            roles.add(options[field]);
        }
        const source = options.source;
        if (
            !size(source) ||
            !positiveInteger(source.byteLength) ||
            !sha256(source.sha256) ||
            !sha256(source.normalizedSha256) ||
            source.sha256 !== request.inputs[options.sourceInputIndex].expectedSha256 ||
            !artifact(options.native) ||
            options.native.sha256 !== request.inputs[options.nativeInputIndex].expectedSha256 ||
            !artifact(options.baseline) ||
            options.baseline.format !== "png" ||
            options.baseline.sha256 !== request.inputs[options.baselineInputIndex].expectedSha256 ||
            !sameSize(options.baseline, source) ||
            !sameSize(options.targetSize, source)
        )
            throw new TypeError("Protected enhancement baseline identities are invalid");
        const protection = options.protection;
        const proof = options.originalProof;
        if (!protection || protection.normalization !== "srgb-upright-v1" || !proof || typeof proof !== "object" || Array.isArray(proof)) throw new TypeError("Enhancement protection or proof is invalid");
        if (options.scope === "product_background") {
            const product = protection.product;
            if (
                protection.version !== "product-enhancement.v2" ||
                !product ||
                product.compilerVersion !== "strict-product.v1" ||
                product.state !== "ready" ||
                typeof product.productAnchorId !== "string" ||
                !product.productAnchorId ||
                product.sourceAssetId !== request.inputs[options.sourceInputIndex].assetId ||
                !sameSize(product.sourceSize, source) ||
                !Array.isArray(product.productCore) ||
                !product.productCore.length ||
                !product.productCore.every(rectangle) ||
                !Array.isArray(product.fusionHalo) ||
                !product.fusionHalo.every(rectangle) ||
                !Array.isArray(product.editableBackground) ||
                !product.editableBackground.every(rectangle) ||
                protection.maskSha256 !== request.inputs[options.maskInputIndex].expectedSha256 ||
                proof.version !== "product-enhancement.v2"
            )
                throw new TypeError("Product enhancement protection is invalid");
        } else {
            const scene = protection.scene;
            if (
                protection.version !== "scene-enhancement.v1" ||
                !scene ||
                scene.version !== "scene-edit-protection.v1" ||
                scene.sourceAssetId !== request.inputs[options.sourceInputIndex].assetId ||
                scene.sourceDigest !== source.sha256 ||
                !sameSize(scene.sourceSize, source) ||
                !sameSize(scene.maskSize, source) ||
                scene.maskDigest !== request.inputs[options.maskInputIndex].expectedSha256 ||
                !rectangle(scene.targetRegion) ||
                !Array.isArray(scene.semantics) ||
                !scene.semantics.length ||
                scene.semantics.some((value) => typeof value !== "string" || !value.trim()) ||
                scene.selectionSource !== "user_selection" ||
                scene.maskSemantics !== "alpha_zero_edit" ||
                scene.method !== "source_pixels_copy" ||
                proof.version !== "scene-edit-protection.v1" ||
                scene.mask !== undefined
            )
                throw new TypeError("Scene enhancement protection requires owned mask bytes");
        }
    }
    if (roles.size !== request.inputs.length) throw new TypeError("Every enhancement input must belong to a frozen role");
}

function validateEnhancementResult(result, request) {
    const options = request.options;
    const receipt = result.enhancement;
    const artifact = result.artifacts[0];
    const ai = result.sourceIdentities[options.aiInputIndex];
    const expected = options.expectedAi;
    if (
        !receipt ||
        receipt.version !== "enhancement-processing-result.v1" ||
        receipt.bindingDigest !== options.bindingDigest ||
        receipt.scope !== options.scope ||
        receipt.aiInputIndex !== options.aiInputIndex ||
        receipt.deliveredArtifactIndex !== 0 ||
        result.results !== undefined ||
        Object.keys(result.geometry).some((key) => key !== "sourceSize") ||
        !receipt.ai ||
        ["width", "height", "sha256", "byteLength", "format"].some((key) => receipt.ai[key] !== expected[key]) ||
        ai.sha256 !== expected.sha256 ||
        ai.bytes !== expected.byteLength ||
        ai.mimeType !== "image/png" ||
        !sameSize(ai, expected) ||
        ai.bytes > options.budgets.ai.maxBytes ||
        BigInt(ai.width) * BigInt(ai.height) > BigInt(Math.min(40_000_000, options.budgets.ai.maxPixels))
    )
        throw new Error("Enhancement receipt differs from its qualified AI identity");
    if (
        artifact.resultId !== options.resultId ||
        artifact.resultIndex !== options.resultIndex ||
        artifact.bytes > options.budgets.delivery.maxBytes ||
        BigInt(artifact.width) * BigInt(artifact.height) > BigInt(Math.min(40_000_000, options.budgets.delivery.maxPixels))
    )
        throw new Error("Enhancement artifact exceeds its frozen result boundary");
    for (const [index, identity] of result.sourceIdentities.entries()) {
        const limits = [];
        if (index === options.aiInputIndex) limits.push(options.budgets.ai);
        if (options.stagedDelivered?.inputIndex === index || (options.scope !== "full_image" && options.baselineInputIndex === index)) limits.push(options.budgets.delivery);
        if (options.scope !== "full_image" && [options.sourceInputIndex, options.nativeInputIndex, options.maskInputIndex].includes(index)) limits.push(options.budgets.input);
        if (identity.bytes > Math.min(...limits.map((limit) => limit.maxBytes)) || BigInt(identity.width) * BigInt(identity.height) > BigInt(Math.min(...limits.map((limit) => limit.maxPixels))))
            throw new Error("Enhancement source exceeds its role budget");
        if (Object.keys(identity).some((key) => !["assetId", "assetVersion", "sha256", "bytes", "mimeType", "width", "height"].includes(key))) throw new Error("Enhancement source identity has unexpected fields");
    }
    if (options.stagedDelivered) {
        const staged = options.stagedDelivered;
        const stored = result.sourceIdentities[staged.inputIndex];
        if (
            artifact.sha256 !== staged.expected.sha256 ||
            artifact.bytes !== staged.expected.byteLength ||
            artifact.mimeType !== `image/${staged.expected.format}` ||
            !sameSize(artifact, staged.expected) ||
            stored.sha256 !== artifact.sha256 ||
            stored.bytes !== artifact.bytes ||
            !sameSize(stored, artifact) ||
            receipt.deliveryEncodingMs !== undefined
        )
            throw new Error("Recovered enhancement must preserve its existing delivery bytes");
    } else if (!Number.isFinite(receipt.deliveryEncodingMs) || receipt.deliveryEncodingMs < 0) throw new Error("Enhancement encoding time is invalid");
    if (options.scope === "full_image") {
        const scale = Math.min(1, options.targetSize.width / expected.width, options.targetSize.height / expected.height);
        if (
            Math.min(options.targetSize.width / expected.width, options.targetSize.height / expected.height) > 1 ||
            artifact.width !== Math.round(expected.width * scale) ||
            artifact.height !== Math.round(expected.height * scale) ||
            (!options.stagedDelivered && artifact.mimeType !== "image/jpeg") ||
            receipt.protection !== undefined
        )
            throw new Error("Global enhancement delivery does not match the requested fit");
    } else {
        const source = result.sourceIdentities[options.sourceInputIndex];
        const native = result.sourceIdentities[options.nativeInputIndex];
        const baseline = result.sourceIdentities[options.baselineInputIndex];
        const mask = result.sourceIdentities[options.maskInputIndex];
        const proof = receipt.protection;
        if (
            source.sha256 !== options.source.sha256 ||
            source.bytes !== options.source.byteLength ||
            !sameSize(source, options.source) ||
            native.sha256 !== options.native.sha256 ||
            native.bytes !== options.native.byteLength ||
            !sameSize(native, options.native) ||
            baseline.sha256 !== options.baseline.sha256 ||
            baseline.bytes !== options.baseline.byteLength ||
            !sameSize(baseline, options.baseline) ||
            artifact.mimeType !== "image/png" ||
            !sameSize(artifact, options.source) ||
            !proof ||
            proof.normalization !== "srgb-upright-v1" ||
            proof.sourceAssetId !== source.assetId ||
            proof.sourceSha256 !== baseline.sha256 ||
            proof.maskSha256 !== mask.sha256 ||
            proof.aiSha256 !== ai.sha256 ||
            proof.compositeSha256 !== artifact.sha256 ||
            !sameSize(proof.sourceSize, source) ||
            !sameSize(proof.aiSize, ai) ||
            proof.protectedChangedPixels !== 0 ||
            !positiveInteger(proof.allowedPixels) ||
            !positiveInteger(proof.protectedPixels) ||
            proof.allowedPixels + proof.protectedPixels !== source.width * source.height
        )
            throw new Error("Protected enhancement receipt is not bound to its source, mask and composite");
        if (options.scope === "product_background") {
            if (proof.version !== "product-enhancement.v2" || proof.productAnchorId !== options.protection.product.productAnchorId) throw new Error("Product enhancement proof identity changed");
        } else {
            const context = proof.mapping?.context;
            const target = proof.mapping?.targetRegion;
            const expectedTarget = options.protection.scene.targetRegion;
            if (proof.version !== "scene-enhancement.v1" || context?.x !== 0 || context.y !== 0 || !sameSize(context, source) || !target || ["x", "y", "width", "height"].some((key) => target[key] !== expectedTarget[key]))
                throw new Error("Scene enhancement context mapping changed");
        }
    }
}

function sameSize(value, expected) {
    return value && value.width === expected.width && value.height === expected.height;
}
