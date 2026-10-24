import { randomUUID, X509Certificate } from "node:crypto";
import type { ImageEnhancementSettings, ImageEnhancementUpdate, EnhancementModel } from "@/lib/image-enhancement-contract";
import { DEFAULT_ENHANCEMENT_TIMEOUT_MS, ENHANCEMENT_REASONS } from "@/lib/image-enhancement-contract";
import { mutateImageEnhancementSettings, readImageEnhancementSettings, type StoredImageEnhancementSettings } from "@/lib/server/database/image-enhancement-repository";
import { decryptSecretValue, encryptSecretValue, isEncryptedSecretValue } from "@/lib/server/secret-crypto";
import { inspectEnhancementWorker } from "@/lib/server/image-enhancement-worker-client";

export class ImageEnhancementConfigError extends Error {
    constructor(
        readonly code: string,
        readonly status = 400,
    ) {
        super(ENHANCEMENT_REASONS[code] ?? ENHANCEMENT_REASONS.invalid_configuration);
    }
}
export async function getImageEnhancementSettings() {
    return adminSettings(await readImageEnhancementSettings());
}
export function saveImageEnhancementSettings(value: unknown) {
    const input = record(value);
    const allowed = ["revision", "enabled", "mode", "endpoint", "trust", "caPem", "token", "clearToken", "timeoutMs", "modelId"];
    if (Object.keys(input).some((key) => !allowed.includes(key))) invalid();
    if (input.mode !== undefined && input.mode !== "remote_api") invalid();
    for (const key of ["endpoint", "token", "modelId", "caPem"] as const) if (input[key] !== undefined && typeof input[key] !== "string") invalid();
    for (const key of ["enabled", "clearToken"] as const) if (input[key] !== undefined && typeof input[key] !== "boolean") invalid();
    if (input.trust !== undefined && input.trust !== "system" && input.trust !== "custom_ca") invalid();
    if (input.timeoutMs !== undefined && input.timeoutMs !== null && (!Number.isSafeInteger(input.timeoutMs) || Number(input.timeoutMs) <= 0 || Number(input.timeoutMs) > 2 ** 31 - 1)) invalid();
    const patch = input as ImageEnhancementUpdate;
    return mutateImageEnhancementSettings((settings) => {
        assertRevision(input.revision, settings);
        const current = settings.profiles[settings.profileId]!;
        const endpoint = patch.endpoint === undefined ? current.endpoint : normalizeEndpoint(patch.endpoint);
        const trust = patch.trust ?? current.trust;
        const caPem = trust === "system" ? "" : patch.caPem?.trim() || current.caPem;
        if (trust === "custom_ca") {
            try {
                if (/PRIVATE KEY/.test(caPem)) invalid();
                new X509Certificate(caPem);
            } catch {
                invalid();
            }
        }
        const previousToken = current.tokenCiphertext ? decryptSecretValue(current.tokenCiphertext) : "";
        const token = patch.clearToken ? "" : patch.token?.trim() || previousToken;
        if (/[^\x21-\x7e]/.test(token) || isEncryptedSecretValue(token) || (patch.clearToken && patch.token?.trim())) invalid();
        const tokenChanged = previousToken !== token;
        const connectionChanged = endpoint !== current.endpoint || trust !== current.trust || caPem !== current.caPem;
        const modelId = patch.modelId ?? settings.modelId;
        if (patch.modelId && modelId !== settings.modelId && (connectionChanged || tokenChanged || !settings.models.some((model) => model.id === modelId))) throw new ImageEnhancementConfigError("model_unavailable");
        const timeoutMs = (patch.timeoutMs === undefined ? settings.timeoutMs : patch.timeoutMs) ?? DEFAULT_ENHANCEMENT_TIMEOUT_MS;
        const changed = connectionChanged || tokenChanged || modelId !== settings.modelId || timeoutMs !== settings.timeoutMs;
        const intentChanged = patch.enabled !== undefined && patch.enabled !== settings.enabled;
        if (connectionChanged) {
            const id = randomUUID();
            settings.profileId = id;
            settings.profiles[id] = { ...current, id, endpoint, trust, caPem, serviceId: null };
        }
        const profile = settings.profiles[settings.profileId]!;
        if (tokenChanged) {
            profile.tokenCiphertext = token ? encryptSecretValue(token) : "";
            profile.credentialRevision = randomUUID();
        }
        if (connectionChanged || tokenChanged) settings.models = [];
        settings.timeoutMs = timeoutMs;
        settings.modelId = modelId;
        if (changed) settings.check = null;
        if (patch.enabled === true && !settings.enabled && !isReady(settings)) throw new ImageEnhancementConfigError("not_ready", 409);
        if (patch.enabled !== undefined) settings.enabled = patch.enabled;
        if (changed || intentChanged) {
            settings.revision = randomUUID();
            settings.checkRunId = null;
            if (settings.check) settings.check = { ...settings.check, revision: settings.revision };
        }
        return adminSettings(settings);
    });
}
export async function checkImageEnhancementSettings(value: unknown) {
    const input = record(value);
    if (Object.keys(input).some((key) => !["revision", "action"].includes(key)) || !["connection", "sample"].includes(String(input.action))) invalid();
    const runId = randomUUID();
    const captured = await mutateImageEnhancementSettings((settings) => {
        assertRevision(input.revision, settings);
        settings.checkRunId = runId;
        settings.check = null;
        return structuredClone(settings);
    });
    const profile = captured.profiles[captured.profileId]!;
    const report = await inspectEnhancementWorker({ ...profile, token: profile.tokenCiphertext ? decryptSecretValue(profile.tokenCiphertext) : "", timeoutMs: captured.timeoutMs, modelId: captured.modelId }, input.action === "sample");
    return mutateImageEnhancementSettings((settings) => {
        assertRevision(captured.revision, settings);
        if (settings.checkRunId !== runId) throw new ImageEnhancementConfigError("configuration_changed", 409);
        settings.check = { ...report.check, revision: settings.revision };
        if (report.models) settings.models = report.models;
        if (report.serviceId && !profile.serviceId) settings.profiles[settings.profileId]!.serviceId = report.serviceId;
        return adminSettings(settings);
    });
}
export type FrozenEnhancementConnection = Readonly<{
    revision: string;
    credentialRef: string;
    serviceId: string;
    timeoutMs: number;
    model: EnhancementModel;
}>;
export async function freezeImageEnhancementConnection(): Promise<FrozenEnhancementConnection | null> {
    return (await captureImageEnhancementPolicy()).connection;
}
export type FrozenImageEnhancementPolicy = Readonly<{
    revision: string;
    enabled: boolean;
    connection: FrozenEnhancementConnection | null;
}>;
export async function captureImageEnhancementPolicy(): Promise<FrozenImageEnhancementPolicy> {
    const settings = await readImageEnhancementSettings();
    if (!settings.enabled || !isReady(settings)) return Object.freeze({ revision: settings.revision, enabled: settings.enabled, connection: null });
    const model = settings.models.find((model) => model.id === settings.modelId)!;
    const connection = Object.freeze({
        revision: settings.revision,
        credentialRef: settings.profileId,
        serviceId: settings.profiles[settings.profileId]!.serviceId!,
        timeoutMs: settings.timeoutMs!,
        model: Object.freeze({ ...model, allowedTiles: Object.freeze([...model.allowedTiles]) }),
    });
    return Object.freeze({ revision: settings.revision, enabled: settings.enabled, connection });
}
// Rotation updates the credential reference, never the snapshot's endpoint ownership.
export async function resolveImageEnhancementConnection(snapshot: FrozenEnhancementConnection) {
    const settings = await readImageEnhancementSettings();
    const profile = settings.profiles[snapshot.credentialRef];
    if (!profile || profile.serviceId !== snapshot.serviceId) throw new ImageEnhancementConfigError("service_identity_changed", 409);
    return { endpoint: profile.endpoint, trust: profile.trust, caPem: profile.caPem, token: decryptSecretValue(profile.tokenCiphertext), serviceId: profile.serviceId, timeoutMs: snapshot.timeoutMs };
}
function isReady(settings: StoredImageEnhancementSettings) {
    return settings.check?.state === "ready" && settings.check.revision === settings.revision && !!settings.profiles[settings.profileId]?.tokenCiphertext && settings.models.some((model) => model.id === settings.modelId);
}
function adminSettings(settings: StoredImageEnhancementSettings): ImageEnhancementSettings {
    const profile = settings.profiles[settings.profileId]!;
    return {
        revision: settings.revision,
        enabled: settings.enabled,
        mode: "remote_api",
        endpoint: profile.endpoint,
        trust: profile.trust,
        hasCa: !!profile.caPem,
        hasToken: !!profile.tokenCiphertext,
        timeoutMs: settings.timeoutMs,
        modelId: settings.modelId,
        models: settings.models,
        ready: isReady(settings),
        check: settings.check,
    };
}
function assertRevision(revision: unknown, settings: StoredImageEnhancementSettings) {
    if (revision !== settings.revision) throw new ImageEnhancementConfigError("configuration_changed", 409);
}
function invalid(): never {
    throw new ImageEnhancementConfigError("invalid_configuration");
}
function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
    return value as Record<string, unknown>;
}
function normalizeEndpoint(value: string) {
    if (!value.trim()) return "";
    try {
        const url = new URL(value.trim());
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || value.includes("?") || value.includes("#")) invalid();
        return url.toString().replace(/\/+$/, "");
    } catch {
        return invalid();
    }
}
