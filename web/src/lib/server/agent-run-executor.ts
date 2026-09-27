import { getAuthSettings } from "@/lib/auth/store";
import { nanoid } from "nanoid";
import { resolveLogicalModelCandidates } from "@/lib/server/logical-model-router";
import { systemAiIdempotencyKey } from "@/lib/server/system-ai-billing";
import { createEditBranch, getAgentRun, selectCurrentSceneBaseline, updateAgentRunById, type AgentRun } from "@/lib/server/agent-run-store";
import { agentPlannerSystemPrompt, agentPlanReply, buildAgentPlannerInput, conversationFallbackReply, plannerAgentSkills, prioritizeAgentPlannerModels, selectAgentSkills, taskPlanSummary } from "@/lib/server/agent-run-surface-policy";
import { getCreativeAssetsByIds, getCreativeConversationContext, listRecentCreativeMediaAssets } from "@/lib/server/creative-runtime-store";
import { toSafeGenerationErrorMessage } from "@/lib/server/generation-errors";
import { parseAgentPlanCall, type AgentFunctionCallResult } from "./agent-function-call";
import { agentModelOptions, agentPlanFallbackExample, agentPlanTool, canContinue, directAgentPlan, directGenerationPreferences, executeTasks, normalizeTasks, planToOps, refundFunctionCall, requestFunctionCall } from "./agent-run-execution";
import { isExplicitProjectHandoffRequest, normalizeAgentProjectHandoff } from "./agent-run-project-handoff";
import { normalizeCanvasPlanForSelection } from "./agent-run-task-input";
import { GenerationSubmissionUncertainError } from "@/lib/server/generation-submission-error";
import { rankTextPlanningCandidates } from "@/lib/server/text-planning-runtime";
import { filterAgentPlannerModels } from "@/lib/server/agent-run-planning-profile";
import { buildAgentRunPlannerAudit } from "@/lib/server/agent-run-audit";
import { agentRequestDigest, buildAgentRequest, serializeAgentRequest } from "@/lib/server/agent-prompt-json";
import { orderCreativeAssetsByIds } from "@/lib/creative-asset-references";
import { withDirectAgentExecutionContext } from "./agent-run-direct-context";
import { buildEcommercePlanningInput, legacyPlanFallback, recordEcommerceGenerationSnapshot } from "./ecommerce-generation-snapshot";
import {
    buildLocalEditProductProtection,
    buildWhiteBackgroundProductProtection,
    createEcommerceLocalEditTask,
    createEcommerceProductSceneTask,
    createEcommerceSceneEditTask,
    ecommerceGenerationEnabled,
    ecommerceRolloutStage,
    isEcommerceImageRequest,
    loadEcommercePlanningImage,
    publicEcommerceProgress,
} from "./ecommerce-generation-service";
import { planEcommerceEdit, resolveLocalEditTarget } from "./ecommerce-edit-planner";
import { classifyReferenceRoles, resolveDualBaseline } from "./ecommerce-reference-roles";
import { analyzeEcommerceReferences } from "./ecommerce-visual-analysis";
import { compileEcommerceImageRequest, resolveEcommerceImageProviderProfile, type EcommerceCompiledImageRequest } from "./ecommerce-image-compiler";
import { resolveEcommerceRoleCandidates, type EcommerceRoleCandidate } from "./ecommerce-model-routing";
import { validateAgentPlanRequestedModels } from "./agent-run-validation";

const globalAgentExecutors = globalThis as typeof globalThis & { __vozebProAgentRunControllers?: Map<string, AbortController> };
const controllers = (globalAgentExecutors.__vozebProAgentRunControllers ??= new Map<string, AbortController>());

export function abortAgentRun(id: string) {
    controllers.get(id)?.abort();
}

export async function executeAgentRun(run: AgentRun, origin: string, cookie: string) {
    abortAgentRun(run.id);
    const controller = new AbortController();
    const executionId = nanoid();
    let acceptedPlan: { userId: string; model: string; channelId: string; upstreamModel: string; call: AgentFunctionCallResult } | undefined;
    let planningPersisted = false;
    let failureStage: NonNullable<AgentRun["failureStage"]> = run.tasks.length ? "task_execution" : "planning";
    const candidateFailures: NonNullable<AgentRun["candidateFailures"]> = [];
    const refundAcceptedPlan = async () => {
        if (!acceptedPlan || planningPersisted) return;
        await refundFunctionCall(acceptedPlan.userId, acceptedPlan.model, acceptedPlan.call);
        acceptedPlan = undefined;
    };
    controllers.set(run.id, controller);
    try {
        const claimed = await updateAgentRunById(
            run.id,
            { status: "running", executionId, timings: { ...(run.timings || { requestAcceptedAt: run.createdAt }), ...(run.tasks.length ? {} : { planningStartedAt: Date.now() }) } },
            { type: run.tasks.length ? "run.resumed" : "run.planning" },
            ["planning", "running"],
        );
        if (!claimed) return;
        if (claimed.tasks.length) {
            failureStage = "task_execution";
            const settings = await getAuthSettings();
            await executeTasks(run.id, origin, cookie, executionId, settings);
            return;
        }
        const directModelSelection = Boolean(claimed.requestedModelIds?.length && claimed.surface !== "chat");
        const usesMemoryCandidates = !directModelSelection && claimed.surface === "chat" && claimed.referencedAssetIds.length === 0;
        const [settings, loadedExplicitAssets, conversationContext, memoryAssets] = await Promise.all([
            getAuthSettings(),
            getCreativeAssetsByIds(claimed.referencedAssetIds, claimed.userId),
            getCreativeConversationContext(claimed.conversationId, claimed.userId, claimed.id),
            usesMemoryCandidates ? listRecentCreativeMediaAssets(claimed.conversationId, claimed.userId, 6) : Promise.resolve([]),
        ]);
        const explicitAssets = orderCreativeAssetsByIds(loadedExplicitAssets, claimed.referencedAssetIds);
        const allModels = agentModelOptions(settings);
        const plannerModels = prioritizeAgentPlannerModels(filterAgentPlannerModels(allModels, claimed), claimed, settings);
        const requestedModelOptions = claimed.generationPreferences?.mode ? plannerModels : allModels;
        const requestedModels = (claimed.requestedModelIds || []).map((id) => requestedModelOptions.find((item) => item.id === id && item.capability !== "text")).filter((item): item is ReturnType<typeof agentModelOptions>[number] => Boolean(item));
        if (requestedModels.length !== (claimed.requestedModelIds || []).length) throw new Error("部分所选模型当前不可用，请重新选择");
        const requestedModelCapabilities = requestedModels.map((model) => model.capability);
        const ecommerceImageRequest = isEcommerceImageRequest(claimed, requestedModelCapabilities);
        const availableModels = claimed.surface === "chat" && requestedModels.length ? requestedModels : plannerModels;
        const skillOptions = plannerAgentSkills(settings, claimed);
        const skills = selectAgentSkills(settings, claimed.surface, claimed.selectedSkillIds);
        if (!(await canContinue(run.id, executionId))) return;
        // Uploaded references carry the sentinel sourceRunId "upload"; only
        // assets linked to a real Agent Run are historical generated results.
        const isHistoricalGeneratedAsset = (asset: { type?: string; sourceRunId?: string }) => asset.type === "image" && Boolean(asset.sourceRunId && asset.sourceRunId !== "upload");
        const explicitHistory = explicitAssets.filter(isHistoricalGeneratedAsset);
        const ecommerceRollout = ecommerceRolloutStage(process.env.ECOMMERCE_GENERATION_ROLLOUT, claimed.userId);
        const continuityResult =
            (ecommerceRollout === "shadow" || ecommerceRollout === "internal" || ecommerceRollout === "canary") && claimed.surface === "chat" && ecommerceImageRequest
                ? await selectCurrentSceneBaseline(claimed.conversationId, explicitHistory[0]?.id, claimed.userId)
                : null;
        const ecommerceAssets = (usesMemoryCandidates ? (continuityResult ? [continuityResult] : memoryAssets) : explicitAssets).filter((asset) => asset.type === "image");
        if (ecommerceRollout === "shadow" && claimed.surface === "chat" && ecommerceAssets.length) {
            const planningInput = buildEcommercePlanningInput(claimed, ecommerceAssets, conversationContext);
            const fallback = legacyPlanFallback({
                userRequest: planningInput.userRequest,
                assetIds: planningInput.assetCandidates.map((asset) => asset.id),
                conversationId: planningInput.conversationId,
                surface: planningInput.surface,
            });
            const shadowSnapshot = recordEcommerceGenerationSnapshot(claimed, {
                version: "ecommerce-generation.v1",
                mode: "shadow",
                input: fallback.input,
                compilerVersion: "legacy-shadow.v1",
                fallback: { reason: fallback.reason },
                createdAt: Date.now(),
            });
            if (!(await updateAgentRunById(run.id, { ecommerceSnapshot: shadowSnapshot }, undefined, ["running"], executionId))) return;
        }
        if (ecommerceGenerationEnabled(process.env.ECOMMERCE_GENERATION_ROLLOUT, claimed, Boolean(continuityResult), requestedModelCapabilities)) {
            let planningAssets = [...ecommerceAssets];
            let planningInput = buildEcommercePlanningInput(claimed, planningAssets, conversationContext);
            let snapshotInput = ecommerceSnapshotInput(planningInput);
            const visionCandidates = resolveEcommerceRoleCandidates(settings, "vision_analysis", "text");
            const editPlanningCandidates = resolveEcommerceRoleCandidates(settings, "edit_planning", "text");
            const imageGenerationRole = resolveEcommerceRoleCandidates(
                {
                    ...settings,
                    ...(requestedModels.length ? { ecommerceModelRoles: { image_generation: requestedModels.map((model) => model.id) } } : {}),
                },
                "image_generation",
                "image",
            )[0];
            const qualityCheckRole = resolveEcommerceRoleCandidates(settings, "quality_check", "text")[0];
            const unavailableRole = [
                ["vision_analysis", visionCandidates],
                ["edit_planning", editPlanningCandidates],
                ["quality_check", qualityCheckRole ? [qualityCheckRole] : []],
            ].find(([, candidates]) => !candidates.length)?.[0];
            if (unavailableRole) throw new Error(`后台尚未配置可用的 ${unavailableRole} 模型角色`);
            if (!imageGenerationRole) throw new Error("后台尚未配置可用的 image_generation 模型角色");
            if (!qualityCheckRole) throw new Error("后台尚未配置可用的 quality_check 模型角色");

            let branchContinuity: { parentResultId: string | null; branchId: string } | null = null;
            const pauseForReview = async (reason: string, message: string, localEdit = false, ecommerceExecution?: EcommerceCompiledImageRequest) => {
                const reviewTask = {
                    id: localEdit ? "ecommerce-local-edit" : "ecommerce-product-scene",
                    title: localEdit ? "商品场景局部修改" : "商品场景图",
                    type: "image" as const,
                    model: imageGenerationRole.logicalModelId,
                    ...(ecommerceExecution ? { ecommerceExecution } : {}),
                    optimizedPrompt: claimed.prompt,
                    prompt: ecommerceExecution?.prompt || claimed.prompt,
                    count: Math.max(1, claimed.generationPreferences?.image?.count || 1),
                    ...(claimed.generationPreferences?.image?.size ? { ratio: claimed.generationPreferences.image.size } : {}),
                    ...(claimed.generationPreferences?.image?.quality ? { quality: claimed.generationPreferences.image.quality } : {}),
                    dependencies: [],
                    status: "needs_review" as const,
                    attempts: 0,
                    error: message,
                };
                const ecommerceSnapshot = recordEcommerceGenerationSnapshot(claimed, {
                    version: "ecommerce-generation.v1",
                    mode: "active",
                    input: snapshotInput,
                    ...(branchContinuity ? { continuity: branchContinuity } : {}),
                    modelRouteSnapshots: { image_generation: imageGenerationRole.snapshot },
                    compilerVersion: ecommerceExecution?.compilerVersion || "strict-product.v1",
                    fallback: { reason },
                    createdAt: Date.now(),
                });
                await updateAgentRunById(
                    run.id,
                    {
                        status: "paused",
                        executionId: undefined,
                        tasks: [reviewTask],
                        reviewed: true,
                        ecommerceSnapshot,
                        timings: { ...(claimed.timings || { requestAcceptedAt: claimed.createdAt }), planningCompletedAt: Date.now() },
                    },
                    { type: "task.needs_review", data: { taskId: reviewTask.id, title: reviewTask.title, error: message } },
                    ["running"],
                    executionId,
                );
            };

            const explicitNewImages = explicitAssets.filter((asset) => asset.type === "image" && !isHistoricalGeneratedAsset(asset));
            if (explicitHistory.length > 1 || explicitHistory.length + explicitNewImages.length > 2) {
                await pauseForReview("invalid_reference_selection", "请只选择一张历史结果和一张新参考图。", true);
                return;
            }
            if (explicitHistory.length && !continuityResult) {
                await pauseForReview("invalid_reference_selection", "无法读取选择的历史结果，请重新选择。", true);
                return;
            }
            if (continuityResult) {
                const preliminary = resolveDualBaseline(claimed, { assets: [], decision: classifyReferenceRoles([], []), results: [continuityResult] });
                if ((preliminary.status !== "resolved" || !preliminary.productAnchorId) && !explicitNewImages.length) {
                    await pauseForReview(preliminary.ambiguityReason || "missing_product_anchor", preliminary.clarificationQuestion || "无法确认历史结果对应的原始商品图。", true);
                    return;
                }
                const loadedAnchors = preliminary.productAnchorId && explicitNewImages.length < 2 ? await getCreativeAssetsByIds([preliminary.productAnchorId], claimed.userId) : [];
                const productAnchor = loadedAnchors.find((asset) => asset.id === preliminary.productAnchorId && asset.conversationId === claimed.conversationId && asset.type === "image" && asset.status === "ready");
                if (!productAnchor && !explicitNewImages.length) {
                    await pauseForReview("missing_product_anchor", "无法读取历史结果对应的原始商品图，请重新提供商品图。", true);
                    return;
                }
                planningAssets = explicitNewImages.length === 2 ? explicitNewImages : productAnchor ? (explicitNewImages.length ? [explicitNewImages[0], productAnchor] : [continuityResult, productAnchor]) : explicitNewImages;
                planningInput = buildEcommercePlanningInput(claimed, planningAssets, conversationContext);
                snapshotInput = ecommerceSnapshotInput(planningInput);
            }

            if (
                !(await updateAgentRunById(
                    run.id,
                    {},
                    {
                        type: "ecommerce.progress",
                        data: { stage: "identifying_product", text: publicEcommerceProgress("identifying_product") },
                    },
                    ["running"],
                    executionId,
                ))
            )
                return;
            let analysis: Awaited<ReturnType<typeof analyzeEcommerceReferences>>;
            try {
                analysis = await analyzeEcommerceReferences({ origin, cookie, userId: claimed.userId, requestId: claimed.id, planningInput }, visionCandidates);
            } catch {
                await pauseForReview("visual_analysis_unavailable", "无法可靠分析参考图，任务已暂停等待复核。");
                return;
            }
            const analysisCompletedAt = Date.now();
            if (!(await canContinue(run.id, executionId))) return;
            const decision = classifyReferenceRoles(
                explicitNewImages,
                analysis.references.map((reference) => ({
                    assetId: reference.assetId,
                    confidence: reference.confidence,
                    ...reference.visualEvidence,
                })),
            );
            const sources = resolveDualBaseline(claimed, { assets: explicitNewImages, decision, results: continuityResult ? [continuityResult] : [] });
            if (sources.status !== "resolved" || (!sources.productAnchorId && !sources.currentSceneBaselineId)) {
                await pauseForReview(sources.ambiguityReason || "reference_roles_need_review", sources.clarificationQuestion || "无法可靠区分商品图和场景参考图，请确认图片角色。");
                return;
            }
            if (sources.productAnchorId && sources.currentSceneBaselineId) {
                const product = analysis.references.find((reference) => reference.assetId === sources.productAnchorId && reference.role === "product" && reference.confidence === "high");
                const scene = analysis.references.find((reference) => reference.assetId === sources.currentSceneBaselineId && reference.role === "scene" && reference.confidence === "high");
                if (!product?.productFacts || !scene?.sceneFacts || !scene.productCore || !scene.fusionHalo) {
                    await pauseForReview("local_edit_visual_ambiguity", "无法可靠确认场景中的商品位置，请重新选择清晰的图片。", true);
                    return;
                }
            }

            if (!(await updateAgentRunById(run.id, {}, { type: "ecommerce.progress", data: { stage: "planning_scene", text: publicEcommerceProgress("planning_scene") } }, ["running"], executionId))) return;
            const branch = sources.parentResultId ? await createEditBranch(sources.parentResultId, claimed, executionId) : null;
            if (sources.parentResultId && !branch) return;
            branchContinuity = branch || { parentResultId: null, branchId: `ecommerce-${claimed.id}` };
            const planning = await planEcommerceEdit(
                {
                    origin,
                    cookie,
                    userId: claimed.userId,
                    requestId: claimed.id,
                    planningInput,
                    sources,
                    branchId: branch?.branchId || `ecommerce-${claimed.id}`,
                    generationModelRole: imageGenerationRole.logicalModelId,
                    qualityCheckModelRole: qualityCheckRole.logicalModelId,
                },
                analysis,
                editPlanningCandidates,
            );
            const planningCompletedAt = Date.now();
            if (!(await canContinue(run.id, executionId))) return;
            const visionRouteSnapshot = executedEcommerceRouteSnapshot(visionCandidates, analysis.modelRole);
            const editPlanningRouteSnapshot = executedEcommerceRouteSnapshot(editPlanningCandidates, planning.modelRole);
            const providerProfile = resolveEcommerceImageProviderProfile(imageGenerationRole.snapshot);
            if (!providerProfile) {
                await pauseForReview("unsupported_image_provider_profile", "当前生图模型尚未配置电商编译器，请切换模型或联系管理员。", Boolean(sources.currentSceneBaselineId));
                return;
            }
            const ecommerceExecution = compileEcommerceImageRequest(planning.plan, providerProfile);
            if (ecommerceExecution.state !== "ready") {
                await pauseForReview(ecommerceExecution.reason || "image_provider_needs_review", "当前生图模型不支持可信独立蒙版，任务已暂停等待复核。", Boolean(sources.currentSceneBaselineId), ecommerceExecution);
                return;
            }
            let task;
            if (planning.plan.operation === "scene_edit") {
                task = createEcommerceSceneEditTask(claimed, planning.plan, planningAssets, ecommerceExecution);
            } else if (sources.currentSceneBaselineId) {
                const target = resolveLocalEditTarget(planning.plan, analysis);
                if (target.state !== "resolved") {
                    await pauseForReview(target.reason, target.clarificationQuestion, true);
                    return;
                }
                const sceneUrl = planningInput.assetCandidates.find((asset) => asset.id === sources?.currentSceneBaselineId)?.url;
                if (!sceneUrl) throw new Error("当前场景基线不可用");
                const sceneBytes = await loadEcommercePlanningImage(sceneUrl, origin, cookie);
                const productProtectionRegions = await buildLocalEditProductProtection(sceneBytes, analysis, sources.currentSceneBaselineId, sources.productAnchorId!, target.target);
                task = createEcommerceLocalEditTask(claimed, planning.plan, planningAssets, productProtectionRegions, ecommerceExecution);
            } else {
                const productUrl = planningInput.assetCandidates.find((asset) => asset.id === sources?.productAnchorId)?.url;
                if (!productUrl) throw new Error("商品锚点图片不可用");
                const productBytes = await loadEcommercePlanningImage(productUrl, origin, cookie);
                const productProtectionRegions = await buildWhiteBackgroundProductProtection(productBytes, analysis, sources.productAnchorId!);
                task = createEcommerceProductSceneTask(claimed, planning.plan, planningAssets, productProtectionRegions, ecommerceExecution);
            }
            const ecommerceSnapshot = recordEcommerceGenerationSnapshot(claimed, {
                version: "ecommerce-generation.v1",
                mode: "active",
                input: snapshotInput,
                continuity: branchContinuity,
                visualAnalysis: analysis,
                plan: planning.plan,
                modelRoles: {
                    visionAnalysis: analysis.modelRole.logicalModelId,
                    editPlanning: planning.modelRole.logicalModelId,
                    generation: imageGenerationRole.logicalModelId,
                    qualityCheck: qualityCheckRole.logicalModelId,
                },
                modelRouteSnapshots: {
                    vision_analysis: visionRouteSnapshot,
                    edit_planning: editPlanningRouteSnapshot,
                    image_generation: imageGenerationRole.snapshot,
                    quality_check: qualityCheckRole.snapshot,
                },
                compilerVersion: ecommerceExecution.compilerVersion,
                stageTimings: { analysisCompletedAt, planningCompletedAt },
                createdAt: Date.now(),
            });
            if (
                !(await updateAgentRunById(
                    run.id,
                    {
                        tasks: [task],
                        reviewed: false,
                        ecommerceSnapshot,
                        timings: { ...(claimed.timings || { requestAcceptedAt: claimed.createdAt }), planningCompletedAt: Date.now() },
                    },
                    { type: "ecommerce.progress", data: { stage: "generating_image", text: publicEcommerceProgress("generating_image") } },
                    ["running"],
                    executionId,
                ))
            )
                return;
            failureStage = "task_execution";
            await executeTasks(run.id, origin, cookie, executionId, settings);
            return;
        }
        if (directModelSelection) {
            const plan = directAgentPlan(requestedModels, claimed.prompt, claimed.referencedAssetIds, claimed.generationPreferences);
            const tasks = withDirectAgentExecutionContext(
                normalizeTasks(plan, skills, settings, claimed.snapshot, claimed.prompt, claimed.surface, explicitAssets, claimed.requestedImageSize, directGenerationPreferences(claimed.generationPreferences)),
                claimed.surface,
                claimed.snapshot,
                conversationContext,
            );
            await updateAgentRunById(run.id, {}, { type: "skills.selected", data: { skills: skills.map((skill) => ({ id: skill.id, name: skill.name })) } }, ["running"], executionId);
            const event = claimed.surface === "canvas" ? { type: "canvas.ops", data: { ops: planToOps(plan, tasks, run.id, claimed.snapshot), reply: plan.reply } } : { type: "run.planned", data: { reply: plan.reply, tasks: tasks.map(taskPlanSummary) } };
            await updateAgentRunById(
                run.id,
                { tasks, foundation: plan.foundation, reviewed: false, plannerAudit: buildAgentRunPlannerAudit({ mode: "direct", skills }), timings: { ...(claimed.timings || { requestAcceptedAt: claimed.createdAt }), planningCompletedAt: Date.now() } },
                event,
                ["running"],
                executionId,
            );
            await executeTasks(run.id, origin, cookie, executionId, settings);
            return;
        }
        const referencedAssets = usesMemoryCandidates ? memoryAssets : explicitAssets;
        const referenceSource = claimed.referencedAssetIds.length ? "current-turn-explicit" : usesMemoryCandidates && referencedAssets.length ? "conversation-memory-candidates" : "none";
        const model = settings.defaultModels.textModel;
        const candidates = resolveLogicalModelCandidates(settings, "text", model);
        if (!model || !candidates.length) throw new Error("后台尚未配置可用的默认文本模型");
        const fallbackExample = agentPlanFallbackExample(availableModels);
        const plannerContext = buildAgentPlannerInput(claimed, conversationContext, referencedAssets, referenceSource, skillOptions, availableModels, settings);
        if (!(await updateAgentRunById(run.id, { plannerContext: plannerContext.summary }, { type: "skills.selected", data: { skills: skills.map((skill) => ({ id: skill.id, name: skill.name })) } }, ["running"], executionId))) return;
        const plannerRequest = buildAgentRequest(claimed, plannerContext.input);
        const planningInput = [
            {
                role: "system",
                content: agentPlannerSystemPrompt(claimed.surface, fallbackExample, settings.site.title),
            },
            {
                role: "user",
                content: serializeAgentRequest(plannerRequest),
            },
        ];
        if (
            !(await updateAgentRunById(
                run.id,
                {
                    promptSchemaVersion: plannerRequest.schema,
                    promptTransport: "json",
                    contextDigest: agentRequestDigest(plannerRequest),
                    plannerStreamMode: undefined,
                    plannerStreamFallbackReason: undefined,
                },
                { type: "run.planning.context_ready" },
                ["running"],
                executionId,
            ))
        )
            return;
        let plan: Awaited<ReturnType<typeof parseAgentPlanCall>> | undefined;
        let latestPlanningError: unknown;
        for (const candidate of rankTextPlanningCandidates(candidates.map((candidate) => ({ ...candidate, channelId: candidate.channel.id })))) {
            try {
                const planCall = await requestFunctionCall(
                    origin,
                    cookie,
                    candidate,
                    planningInput,
                    agentPlanTool,
                    "create_agent_plan",
                    controller.signal,
                    run.userId,
                    model,
                    false,
                    systemAiIdempotencyKey("agent-plan", run.userId, run.id, candidate.channel.id, candidate.upstreamModel),
                    true,
                    () =>
                        updateAgentRunById(run.id, { timings: { ...(claimed.timings || { requestAcceptedAt: claimed.createdAt }), plannerFirstByteAt: Date.now() } }, { type: "run.planning.model_connected" }, ["running"], executionId).then(
                            () => undefined,
                        ),
                );
                await updateAgentRunById(
                    run.id,
                    {
                        plannerStreamMode: planCall.transport || "complete",
                        ...(planCall.fallbackReason ? { plannerStreamFallbackReason: planCall.fallbackReason } : {}),
                    },
                    { type: "run.planning.validating" },
                    ["running"],
                    executionId,
                );
                plan = await parseAgentPlanCall(planCall, () => refundFunctionCall(claimed.userId, model, planCall), undefined, {
                    allowProjectHandoff: claimed.surface === "chat" && isExplicitProjectHandoffRequest(claimed.prompt),
                    requiredGenerationMode: claimed.generationPreferences?.mode,
                });
                validateAgentPlanRequestedModels(plan, claimed.requestedModelIds || []);
                if (plan) acceptedPlan = { userId: claimed.userId, model, channelId: candidate.channel.id, upstreamModel: candidate.upstreamModel, call: planCall };
                break;
            } catch (error) {
                if (controller.signal.aborted) throw error;
                if (error instanceof GenerationSubmissionUncertainError) throw error;
                latestPlanningError = error;
                candidateFailures.push({ channelId: candidate.channel.id, upstreamModel: candidate.upstreamModel, error: toSafeGenerationErrorMessage(error, "规划渠道调用失败") });
            }
        }
        if (!plan) throw latestPlanningError instanceof Error ? latestPlanningError : new Error("没有可用的文本模型渠道");
        if (claimed.surface === "canvas") plan = normalizeCanvasPlanForSelection(plan, claimed.snapshot, claimed.prompt);
        const plannerAudit = buildAgentRunPlannerAudit({
            mode: "model",
            logicalModelId: model,
            channelId: acceptedPlan?.channelId,
            upstreamModel: acceptedPlan?.upstreamModel,
            protocol: acceptedPlan?.call.protocol,
            elapsedMs: acceptedPlan?.call.elapsedMs,
            pointsCost: acceptedPlan?.call.pointsCost,
            pointsRecordId: acceptedPlan?.call.pointsRecordId,
            skills,
        });
        if (!(await canContinue(run.id, executionId))) {
            await refundAcceptedPlan();
            return;
        }
        if (plan.intent === "conversation") {
            const completed = await updateAgentRunById(
                run.id,
                {
                    status: "completed",
                    tasks: [],
                    reviewed: true,
                    plannerAudit,
                    executionId: undefined,
                    timings: { ...(claimed.timings || { requestAcceptedAt: claimed.createdAt }), planningCompletedAt: Date.now(), allResultsReadyAt: Date.now(), runCompletedAt: Date.now() },
                },
                { type: "run.completed", data: { completed: 0, reply: plan.reply?.trim() || conversationFallbackReply(claimed.surface) } },
                ["running"],
                executionId,
            );
            if (!completed) {
                await refundAcceptedPlan();
                return;
            }
            planningPersisted = true;
            return;
        }
        const tasks = normalizeTasks(plan, skills, settings, claimed.snapshot, claimed.prompt, claimed.surface, referencedAssets, claimed.requestedImageSize, claimed.generationPreferences);
        const projectHandoff = normalizeAgentProjectHandoff(plan, claimed.surface, referencedAssets, claimed.prompt);
        const reply = agentPlanReply({ ...plan, projectHandoff }, tasks, claimed.surface);
        const event = claimed.surface === "canvas" ? { type: "canvas.ops", data: { ops: planToOps(plan, tasks, run.id, claimed.snapshot), reply } } : { type: "run.planned", data: { reply, tasks: tasks.map(taskPlanSummary), projectHandoff } };
        const planned = await updateAgentRunById(
            run.id,
            { tasks, foundation: plan.foundation, projectHandoff, reviewed: tasks.length ? claimed.reviewed : true, plannerAudit, timings: { ...(claimed.timings || { requestAcceptedAt: claimed.createdAt }), planningCompletedAt: Date.now() } },
            event,
            ["running"],
            executionId,
        );
        if (!planned) {
            await refundAcceptedPlan();
            return;
        }
        planningPersisted = true;
        failureStage = "task_execution";
        await executeTasks(run.id, origin, cookie, executionId, settings);
    } catch (error) {
        let failure = error;
        try {
            await refundAcceptedPlan();
        } catch (refundError) {
            console.error("Agent planning refund failed", refundError instanceof Error ? refundError.message : refundError);
            failure = refundError;
            failureStage = "refund";
        }
        const latest = await getAgentRun(run.id);
        if (latest && !["paused", "cancelled"].includes(latest.status))
            await updateAgentRunById(
                run.id,
                {
                    status: "failed",
                    executionId: undefined,
                    failure: toSafeGenerationErrorMessage(failure, "Agent 执行失败"),
                    failureStage,
                    candidateFailures: candidateFailures.length ? candidateFailures : undefined,
                    timings: { ...(latest.timings || { requestAcceptedAt: latest.createdAt }), runCompletedAt: Date.now() },
                },
                { type: "run.failed", data: { message: toSafeGenerationErrorMessage(failure, "Agent 执行失败") } },
                ["planning", "running"],
                executionId,
            );
    } finally {
        if (controllers.get(run.id) === controller) controllers.delete(run.id);
    }
}

function executedEcommerceRouteSnapshot(candidates: EcommerceRoleCandidate[], actual: { logicalRole: string; logicalModelId: string; channelId: string; upstreamModel: string }) {
    const matched = candidates.find((candidate) => candidate.logicalRole === actual.logicalRole && candidate.logicalModelId === actual.logicalModelId && candidate.channelId === actual.channelId && candidate.upstreamModel === actual.upstreamModel);
    if (!matched) throw new Error(`电商 ${actual.logicalRole} 模型执行结果与候选快照不一致`);
    return matched.snapshot;
}

function ecommerceSnapshotInput(input: ReturnType<typeof buildEcommercePlanningInput>) {
    return {
        userRequest: input.userRequest,
        assetIds: input.assetCandidates.map((asset) => asset.id),
        conversationId: input.conversationId,
        surface: input.surface,
    };
}
