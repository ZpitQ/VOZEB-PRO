import type { ImageTask, ImageTaskConfig, ImageTaskReference } from "./image-task-store";
import { resolveEcommerceImageProviderProfile, type EcommerceCompiledImageRequest } from "./ecommerce-image-compiler";
import { routeEcommerceRole } from "./ecommerce-model-routing";
import { compileStrictProductEdit, type ProductProtectionRegions } from "./ecommerce-product-regions";
import { scheduleGenerationTask } from "./generation-task-scheduler";

type EcommerceSettings = Parameters<typeof routeEcommerceRole>[0];

export class EcommerceImageTaskPreparationError extends Error {
    constructor(
        message: string,
        readonly status: 400 | 409 = 400,
    ) {
        super(message);
        this.name = "EcommerceImageTaskPreparationError";
    }
}

export function assertEcommerceImageExecutionSnapshot(settings: EcommerceSettings, execution?: EcommerceCompiledImageRequest) {
    if (!execution) return;
    if (!validExecutionShape(execution)) throw new EcommerceImageTaskPreparationError("电商生图执行快照无效");
    const exactRoute = routeEcommerceRole(settings, "image_generation", execution.modelSnapshot);
    const exactProfile = resolveEcommerceImageProviderProfile(execution.modelSnapshot);
    if (
        !exactRoute ||
        !exactProfile ||
        exactProfile.profileId !== execution.providerProfileId ||
        exactProfile.modelSnapshot.apiFormat !== execution.modelSnapshot.apiFormat ||
        compilerVersionForProfile(exactProfile.compilerFamily) !== execution.compilerVersion
    ) {
        throw new EcommerceImageTaskPreparationError("电商生图执行快照已失效，请重新发起任务", 409);
    }
}

export function prepareEcommerceImageTask(input: {
    ecommerceExecution?: EcommerceCompiledImageRequest;
    kind: ImageTask["kind"];
    prompt: string;
    references: ImageTaskReference[];
    mask?: ImageTaskReference;
    productProtectionRegions?: ProductProtectionRegions;
    compatibleConfigs: ImageTaskConfig[];
}) {
    const baseConfig = input.compatibleConfigs[0];
    if (!baseConfig) throw new EcommerceImageTaskPreparationError("当前模型能力不满足参考素材、比例或分辨率参数");
    if (input.ecommerceExecution && (input.prompt !== input.ecommerceExecution.prompt || !sameReferences(input.references, input.ecommerceExecution.referenceRoles))) {
        throw new EcommerceImageTaskPreparationError("电商生图执行内容与快照不一致");
    }
    let config = baseConfig;
    let prompt = input.prompt;
    let mask = input.mask;
    let productProtection: ImageTask["productProtection"];
    let reviewReason = "";
    if (input.productProtectionRegions) {
        if (input.kind !== "edit") throw new EcommerceImageTaskPreparationError("严格商品保护只支持图片编辑任务");
        try {
            const selected = input.compatibleConfigs.map((candidate) => ({
                config: candidate,
                result: compileStrictProductEdit({ kind: "edit", prompt: input.prompt, config: candidate, references: input.references }, input.productProtectionRegions!),
            }));
            const compilation = selected.find((candidate) => candidate.result.state === "ready") || selected[0];
            if (!compilation) throw new Error("当前模型能力不满足严格商品保护");
            config = compilation.config;
            prompt = compilation.result.task.prompt;
            mask = compilation.result.task.mask;
            productProtection = compilation.result.task.productProtection;
            if (compilation.result.state === "needs_review") reviewReason = compilation.result.reason;
        } catch (error) {
            throw new EcommerceImageTaskPreparationError(error instanceof Error ? error.message : "商品保护区域无效");
        }
    }
    return {
        config,
        candidateConfigs: productProtection || input.ecommerceExecution ? [] : input.compatibleConfigs.slice(1),
        prompt,
        mask,
        productProtection,
        reviewReason,
    };
}

export async function schedulePreparedImageTask(task: ImageTask, reviewReason: string) {
    if (reviewReason) {
        await scheduleGenerationTask("image", task.id, {
            executionPhase: "needs_review",
            channelId: task.config.channelId,
            provider: task.config.advancedConfig?.protocol || task.config.apiFormat,
            nextPollAt: undefined,
            lastUpstreamStatus: "strict_product_mask_review_required",
            resultPayload: { reviewReason },
        });
        return { needsReview: true as const, reviewReason };
    }
    await scheduleGenerationTask("image", task.id, {
        executionPhase: "created",
        channelId: task.config.channelId,
        provider: task.config.advancedConfig?.protocol || task.config.apiFormat,
        nextPollAt: Date.now(),
        lastUpstreamStatus: "created",
    });
    return { needsReview: false as const };
}

function validExecutionShape(value: EcommerceCompiledImageRequest) {
    return (
        value.state === "ready" &&
        Boolean(value.prompt?.trim()) &&
        Boolean(value.compilerVersion) &&
        Boolean(value.providerProfileId) &&
        Boolean(value.modelSnapshot) &&
        value.modelSnapshot.logicalRole === "image_generation" &&
        value.modelSnapshot.capability === "image" &&
        Array.isArray(value.referenceRoles)
    );
}

function compilerVersionForProfile(family: "openai-image-2.5" | "nano-banana-2") {
    return family === "openai-image-2.5" ? "ecommerce-openai-image-2.5.v1" : "ecommerce-nano-banana-2.v1";
}

function sameReferences(references: ImageTaskReference[], roles: EcommerceCompiledImageRequest["referenceRoles"]) {
    return references.length === roles.length && references.every((reference, index) => reference.id === roles[index]?.assetId && reference.ecommerceRole === roles[index]?.role);
}
