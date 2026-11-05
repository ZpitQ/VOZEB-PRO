import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ImageProcessingEnhancementOptions } from "../image-processing/contracts";
import type { ImageProcessingResourceFacts } from "../image-processing/resource-model";
import type { ImageEnhancementJob } from "./database/image-enhancement-job-repository";
import { getStoredGenerationTaskRecord } from "./generation-task-store";
import {
    currentEnhancementPublicationBinding,
    enhancementInputAssetVersion,
    enhancementOptionsForBinding,
    findEnhancementPublicationChild,
    EnhancementProcessingConflict,
    type EnhancementInputRoles,
    type PreparedEnhancementPublication,
} from "./image-enhancement-processing-store";
import { readEnhancementProcessingFacts, readVerifiedEnhancementMedia } from "./image-enhancement-processing-media";
import type { EnhancementPublicationFrozenInput } from "./image-enhancement-publication-binding";
import type { ImageProcessingMediaReference } from "./image-processing-service";
import { getLocalMediaRegistration, isLocalMediaRegistrationExpired, type LocalMediaRegistration } from "./local-media-registry";
import { writeReferenceMediaFile } from "./reference-asset-store";

function conflict(message: string): never {
    throw new EnhancementProcessingConflict(message);
}
type ExpectedInput = { sha256: string; byteLength: number; width: number; height: number; mimeType: string };

function ownedLocation(value: string) {
    const url = new URL(value, "http://enhancement-input.local");
    const scope = url.pathname.startsWith("/api/generation-log-assets/") ? "generation" : url.pathname.startsWith("/api/reference-assets/") ? "reference" : undefined;
    if (!scope) conflict("Enhancement input is not registered server media");
    const prefix = scope === "generation" ? "/api/generation-log-assets/" : "/api/reference-assets/";
    return { scope, storageKey: url.pathname.slice(prefix.length).split("/").map(decodeURIComponent).join("/") };
}
async function ownedRegistration(url: string, userId: string) {
    const location = ownedLocation(url);
    const registration = await getLocalMediaRegistration(location.storageKey);
    if (!registration || registration.ownerUserId !== userId || registration.scope !== location.scope || registration.type !== "image" || isLocalMediaRegistrationExpired(registration, Date.now()))
        conflict("Enhancement input registration, owner or expiry changed");
    return registration;
}
async function stageInlineMask(bytes: Buffer, parent: ImageEnhancementJob, maxBytes: number) {
    if (!bytes.length || bytes.length > maxBytes) conflict("Enhancement raw input exceeds its frozen byte budget");
    const directory = await mkdtemp(join(tmpdir(), "vozeb-enhancement-stage-"));
    const filePath = join(directory, "raw-input.png");
    try {
        await writeFile(filePath, bytes, { flag: "wx" });
        const stored = await writeReferenceMediaFile(filePath, "image", "image/png", false, { ownerUserId: parent.userId, source: "enhancement-mask", taskId: parent.id, maxBytes });
        return await ownedRegistration("/api/reference-assets/" + stored.token.split("/").map(encodeURIComponent).join("/"), parent.userId);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}
async function stageDownloaded(parent: ImageEnhancementJob, download: (destination: string) => Promise<void>, maxBytes: number) {
    const directory = await mkdtemp(join(tmpdir(), "vozeb-enhancement-download-"));
    const filePath = join(directory, "raw-ai.png");
    try {
        await download(filePath);
        const stored = await writeReferenceMediaFile(filePath, "image", "image/png", false, { ownerUserId: parent.userId, source: "enhancement-raw-ai", taskId: parent.id, maxBytes });
        return await ownedRegistration("/api/reference-assets/" + stored.token.split("/").map(encodeURIComponent).join("/"), parent.userId);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}
function inlineMask(dataUrl: string, maxBytes: number) {
    const prefix = "data:image/png;base64,";
    if (!dataUrl.startsWith(prefix) || dataUrl.length > prefix.length + Math.ceil(maxBytes / 3) * 4 || !/^data:image\/png;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(dataUrl))
        conflict("Enhancement mask must be strict bounded inline PNG or owned server media");
    const encoded = dataUrl.slice(prefix.length);
    const bytes = Buffer.from(encoded, "base64");
    if (!bytes.length || bytes.toString("base64") !== encoded || bytes.length > maxBytes) conflict("Enhancement mask bytes are invalid");
    return bytes;
}

/** Produces frozen owned inputs and metadata facts only; no CPU receipt or staged.ai qualification is invented. */
export async function prepareEnhancementPublication(parent: ImageEnhancementJob, download: (destination: string) => Promise<void>): Promise<PreparedEnhancementPublication> {
    const image = await getStoredGenerationTaskRecord("image", parent.imageTaskId);
    const binding = currentEnhancementPublicationBinding(parent, image, Date.now());
    const orphan = await findEnhancementPublicationChild(parent, binding.bindingDigest);
    if (orphan) {
        const facts = await readEnhancementProcessingFacts(orphan);
        if (!isDeepStrictEqual(facts, orphan.payload.resource.facts)) conflict("Enhancement orphan input facts changed");
        const aiInputIndex = orphan.payload.options.aiInputIndex;
        const source = orphan.payload.sources.find((value) => value.inputIndex === aiInputIndex)!;
        return { binding, options: orphan.payload.options, inputs: orphan.payload.inputs, sources: orphan.payload.sources, facts, frozenInputs: orphan.payload.enhancementInputs, rawAi: { input: orphan.payload.inputs[aiInputIndex], source } };
    }
    const inputs: PreparedEnhancementPublication["inputs"] = [];
    const sources: ImageProcessingMediaReference[] = [];
    const frozenInputs: EnhancementPublicationFrozenInput[] = [];
    const encodedInputs: Array<ImageProcessingResourceFacts["encodedInputs"][number]> = [];
    const decodedInputs: Array<ImageProcessingResourceFacts["decodedInputs"][number]> = [];
    const facts: ImageProcessingResourceFacts = { encodedInputs, decodedInputs };
    const add = async (assetId: string, registration: LocalMediaRegistration, expected: ExpectedInput, budget: { maxBytes: number; maxPixels: number }) => {
        if (registration.bytes !== expected.byteLength || registration.mimeType !== expected.mimeType) conflict("Enhancement owned input bytes or MIME differ from its frozen facts");
        const checked = await readVerifiedEnhancementMedia(registration, { sha256: expected.sha256, bytes: expected.byteLength, width: expected.width, height: expected.height, mimeType: expected.mimeType }, budget);
        try {
            const inputIndex = inputs.length;
            const observed = { expectedSha256: expected.sha256, width: expected.width, height: expected.height };
            const input = { assetId, assetVersion: enhancementInputAssetVersion(registration, observed), expectedSha256: expected.sha256 };
            const source: ImageProcessingMediaReference = {
                inputIndex,
                scope: registration.scope,
                storageKey: registration.storageKey,
                storageProvider: registration.storageProvider === "object" ? "object" : "local",
                ...(registration.externalStorageId ? { externalStorageId: registration.externalStorageId } : {}),
            };
            inputs.push(input);
            sources.push(source);
            frozenInputs.push({ ...input, ...source, ownerUserId: parent.userId, bytes: expected.byteLength, width: expected.width, height: expected.height, mimeType: expected.mimeType });
            const identity = { inputIndex, assetId, assetVersion: input.assetVersion, sha256: expected.sha256 };
            encodedInputs.push({ ...identity, bytes: expected.byteLength, layout: checked.metadata });
            decodedInputs.push({ ...identity, width: expected.width, height: expected.height });
            return inputIndex;
        } finally {
            await checked.dispose();
        }
    };
    const plan = binding.remotePlan;
    const aiBudget = { ...plan.budgets.ai, maxPixels: Math.min(40_000_000, plan.budgets.ai.maxPixels) };
    const deliveryBudget = { ...plan.budgets.delivery, maxPixels: Math.min(40_000_000, plan.budgets.delivery.maxPixels) };
    if (parent.staged?.ai) {
        const { url: _url, ...stagedAi } = parent.staged.ai;
        if (!isDeepStrictEqual(stagedAi, binding.remoteResult)) conflict("Enhancement staged AI descriptor differs from its remote result");
    }
    const aiRegistration = parent.staged?.ai ? await ownedRegistration(parent.staged.ai.url, parent.userId) : await stageDownloaded(parent, download, plan.budgets.ai.maxBytes);
    const aiInputIndex = await add("ai:" + parent.id, aiRegistration, { ...binding.remoteResult, mimeType: "image/png" }, aiBudget);
    let stagedDelivered: ImageProcessingEnhancementOptions["stagedDelivered"];
    if (parent.staged?.delivered) {
        const { url, ...expected } = parent.staged.delivered;
        const inputIndex = await add("delivery:" + parent.id, await ownedRegistration(url, parent.userId), { ...expected, mimeType: "image/" + expected.format }, deliveryBudget);
        stagedDelivered = { inputIndex, expected };
    }
    let roles: EnhancementInputRoles = { scope: "full_image", aiInputIndex, ...(stagedDelivered ? { stagedDelivered } : {}) };
    const delivery = binding.decision.delivery;
    if (delivery && delivery.contract.scope !== "full_image") {
        const contract = delivery.contract;
        const sourceAssetId = contract.scope === "product_background" ? contract.protection.product.sourceAssetId : contract.protection.scene.sourceAssetId;
        const source = await ownedRegistration(contract.baseline.url, parent.userId);
        const sourceInputIndex = await add(sourceAssetId, source, { ...contract.baseline, mimeType: source.mimeType }, plan.budgets.input);
        const native = binding.decision.source;
        const nativeInputIndex = await add("native:" + parent.id, await ownedRegistration(native.url, parent.userId), { ...native, mimeType: "image/" + native.format }, plan.budgets.input);
        const baselineInputIndex = await add("baseline:" + parent.id, await ownedRegistration(delivery.baseline.url, parent.userId), { ...delivery.baseline, mimeType: "image/png" }, deliveryBudget);
        const maskDigest = contract.scope === "product_background" ? contract.protection.maskSha256 : contract.protection.scene.maskDigest;
        const maskSize = contract.scope === "product_background" ? contract.protection.product.sourceSize : contract.protection.scene.maskSize;
        const maskLocation =
            contract.scope === "product_background" ? contract.protection.maskDataUrl : contract.protection.scene.mask.serverUrl || contract.protection.scene.mask.url || contract.protection.scene.mask.remoteUrl || contract.protection.scene.mask.dataUrl;
        const mask = maskLocation.startsWith("data:") ? await stageInlineMask(inlineMask(maskLocation, plan.budgets.input.maxBytes), parent, plan.budgets.input.maxBytes) : await ownedRegistration(maskLocation, parent.userId);
        const maskInputIndex = await add("mask:" + parent.id, mask, { ...maskSize, sha256: maskDigest, byteLength: mask.bytes, mimeType: "image/png" }, plan.budgets.input);
        roles = { scope: contract.scope, aiInputIndex, ...(stagedDelivered ? { stagedDelivered } : {}), sourceInputIndex, nativeInputIndex, baselineInputIndex, maskInputIndex };
    }
    const options = enhancementOptionsForBinding(binding, roles, Boolean(stagedDelivered));
    return { binding, options, inputs, sources, frozenInputs, facts, rawAi: { input: inputs[aiInputIndex], source: sources[aiInputIndex] } };
}
