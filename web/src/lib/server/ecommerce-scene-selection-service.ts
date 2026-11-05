import { isDeepStrictEqual } from "node:util";
import type { ImageProcessingRectangle } from "../image-processing/contracts";
import { validPixelRectangle } from "../image-processing/protection-masks";
import { AGENT_RUN_TTL_MS, getAgentRun, type AgentRun } from "./agent-run-store";
import { assetAccessUrl } from "./agent-run-surface-policy";
import { getCreativeAssetsByIds, mutateCreativeRun } from "./creative-runtime-store";
import { ecommerceSceneSelectionTask } from "./ecommerce-generation-snapshot";
import { readCompletedEcommerceReference, verifyPreparedEcommerceReferenceSource } from "./ecommerce-reference-preparation";
import { ecommerceSceneSelectionReceiptState, hasOnlyCompletedEcommerceReferencePrepares, imageProcessingManifestDigest, type SceneSelectionReceipt } from "./image-processing-service";

type SceneSelection = { baselineAssetId: string; region: ImageProcessingRectangle };

function parseSceneSelection(value: unknown): SceneSelection | undefined {
    if (!value || typeof value !== "object" || !("baselineAssetId" in value) || typeof value.baselineAssetId !== "string" || !("region" in value) || !value.region || typeof value.region !== "object") return;
    const region = value.region;
    if (!("x" in region) || !("y" in region) || !("width" in region) || !("height" in region) || typeof region.x !== "number" || typeof region.y !== "number" || typeof region.width !== "number" || typeof region.height !== "number") return;
    return { baselineAssetId: value.baselineAssetId, region: { x: region.x, y: region.y, width: region.width, height: region.height } };
}

export { ecommerceSceneSelectionReceiptState } from "./image-processing-service";

function matchingReplay(run: AgentRun, selection: SceneSelection, actorUserId: string, expected?: Omit<SceneSelectionReceipt, "confirmation">) {
    const state = ecommerceSceneSelectionReceiptState(run);
    if (
        !state ||
        run.cancellation ||
        !["paused", "running"].includes(run.status) ||
        state.receipt.confirmation.actorUserId !== actorUserId ||
        selection.baselineAssetId !== state.receipt.baseline.assetId ||
        !isDeepStrictEqual(selection.region, state.receipt.region)
    )
        return;
    const { confirmation: _confirmation, ...identity } = state.receipt;
    if (expected && !isDeepStrictEqual(identity, expected)) return;
    return run;
}

export function replayEcommerceSceneSelection(run: AgentRun, selection: unknown, actorUserId: string) {
    const parsed = parseSceneSelection(selection);
    return parsed && matchingReplay(run, parsed, actorUserId);
}

export async function resumeEcommerceSceneSelection(input: { run: AgentRun; selection: unknown; actorUserId: string; origin: string; cookie: string }): Promise<{ run: AgentRun; replayed: boolean } | null> {
    const { run, actorUserId } = input;
    const task = ecommerceSceneSelectionTask(run);
    const plan = run.ecommerceSnapshot?.plan;
    const execution = task?.ecommerceExecution;
    const processing = run.ecommerceSnapshot?.processing;
    const selection = parseSceneSelection(input.selection);
    if (!task || !plan || !execution || !processing) throw new Error("当前任务不能确认编辑区域");
    if (!actorUserId.trim() || !selection) throw new Error("请在原图上确认允许编辑的区域，包含新增物体及其接触阴影");
    if (selection.baselineAssetId !== plan.source.currentSceneBaselineId) throw new Error("选区与任务的原图基线不匹配");
    const ids = execution.referenceRoles.map((reference) => reference.assetId);
    const assets = await getCreativeAssetsByIds(ids, run.userId);
    if (ids.some((id) => !assets.some((asset) => asset.id === id && asset.userId === run.userId && asset.conversationId === run.conversationId && asset.type === "image" && asset.status === "ready" && assetAccessUrl(asset))))
        throw new Error("参考图片不可用或没有访问权限");
    const prepared = await readCompletedEcommerceReference(run, selection.baselineAssetId);
    const reference = run.ecommerceSnapshot?.referenceCheckpoint?.assets.find((item) => item.asset.id === selection.baselineAssetId);
    const prepare = processing.prepareReferences.find((item) => item.assetId === selection.baselineAssetId);
    if (!prepared || !reference?.contentSha256 || !prepare?.manifest) throw new Error("原图缺少本次任务已完成的预处理证据");
    if (!validPixelRectangle(selection.region, prepared.sourceSize)) throw new Error("允许编辑区域越界或尺寸无效");
    if (selection.region.width * selection.region.height === prepared.sourceSize.width * prepared.sourceSize.height) throw new Error("整图选区必须使用全局编辑范围");
    if (!plan.delta.requestedChanges.length || plan.delta.requestedChanges.some((value) => !value.trim())) throw new Error("允许编辑区域缺少语义");
    if (plan.canvas?.mode !== "exact" || plan.canvas.size.width !== prepared.sourceSize.width || plan.canvas.size.height !== prepared.sourceSize.height) throw new Error("局部编辑必须保持原图画幅，请重新发起符合原图尺寸的请求");
    await verifyPreparedEcommerceReferenceSource(prepared, input.origin, input.cookie);
    const receipt: Omit<SceneSelectionReceipt, "confirmation"> = {
        version: "scene-selection-receipt.v1",
        parentTaskId: task.id,
        baseline: { assetId: selection.baselineAssetId, assetVersion: reference.assetVersion, sha256: prepared.contentSha256, bytes: prepared.sourceBytes, ...prepared.sourceSize },
        prepare: { jobId: prepare.jobId, inputDigest: prepare.inputDigest, executionId: prepare.manifest.executionId, manifestDigest: imageProcessingManifestDigest(prepare.manifest), assetVersion: prepare.assetVersion },
        region: selection.region,
        semantics: [...plan.delta.requestedChanges],
    };
    const updated = await mutateCreativeRun<AgentRun>(
        run.id,
        AGENT_RUN_TTL_MS,
        (current, context) => {
            const snapshot = current.ecommerceSnapshot;
            const checkpoint = snapshot?.processing;
            if (
                !ecommerceSceneSelectionTask(current) ||
                !snapshot ||
                !checkpoint ||
                current.userId !== run.userId ||
                current.conversationId !== run.conversationId ||
                !isDeepStrictEqual(current.tasks, run.tasks) ||
                !isDeepStrictEqual(snapshot, run.ecommerceSnapshot) ||
                !hasOnlyCompletedEcommerceReferencePrepares(current, context.persistedChildren)
            )
                return null;
            return {
                run: { ...current, status: "running", executionId: undefined, ecommerceSnapshot: { ...snapshot, processing: { ...checkpoint, sceneSelection: { ...receipt, confirmation: { actorUserId, confirmedAt: Date.now() } } } } },
                event: { type: "run.resumed" },
                assistant: { status: "running" },
            };
        },
        ["paused"],
        undefined,
        { resumeWithChildren: true },
    );
    if (updated) return { run: updated, replayed: false };
    const latest = await getAgentRun(run.id);
    const replay = latest && matchingReplay(latest, selection, actorUserId, receipt);
    return replay ? { run: replay, replayed: true } : null;
}
