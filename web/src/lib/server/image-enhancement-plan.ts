import type { FrozenEnhancementConnection } from "./image-enhancement-config";
import type { ImageEnhancementSkip } from "@/lib/image-enhancement-contract";

export type EnhancementSource = {
    url: string;
    sha256: string;
    width: number;
    height: number;
    byteLength: number;
    format: string;
    hasAlpha: boolean;
    provenance: "provider_native" | "ai_enhanced";
};
type Dimensions = { width: number; height: number };
export type EnhancementPlanningInput = {
    nativeValid: boolean;
    enabled: boolean;
    requested4k: boolean;
    protectedContract: boolean;
    layered: boolean;
    source: EnhancementSource;
    target: Dimensions;
    connection: FrozenEnhancementConnection | null;
};
type EnhancementSkipReason = ImageEnhancementSkip["reason"] | "provider_unavailable" | "native_sufficient" | "already_enhanced" | "unsupported_transparency" | "unsupported_media_type" | "aspect_ratio_mismatch" | "unsupported_target";
type NativeSnapshot = { source: Readonly<EnhancementSource>; target: Readonly<Dimensions> };
export type EnhancementDecision = Readonly<
    NativeSnapshot & ({ status: "queued"; reason: null; connection: FrozenEnhancementConnection; inference: Readonly<Dimensions> } | { status: "skipped"; reason: EnhancementSkipReason } | { status: "rejected"; reason: "native_invalid" })
>;

export function imageEnhancementExclusion(input: Pick<EnhancementPlanningInput, "enabled" | "requested4k" | "protectedContract" | "layered">): ImageEnhancementSkip | undefined {
    const reason = !input.enabled ? "disabled" : !input.requested4k ? "not_requested" : input.protectedContract ? "protected_contract" : input.layered ? "unsupported_layers" : undefined;
    return reason ? Object.freeze({ status: "skipped", reason }) : undefined;
}

export function planImageEnhancement(input: EnhancementPlanningInput): EnhancementDecision {
    const source = Object.freeze({ ...input.source });
    const target = Object.freeze({ ...input.target });
    const skipped = (reason: EnhancementSkipReason): EnhancementDecision => Object.freeze({ status: "skipped", reason, source, target });
    const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
    if (!input.nativeValid || ![source.width, source.height, source.byteLength].every(positive) || !source.url || !/^[a-f0-9]{64}$/.test(source.sha256)) return Object.freeze({ status: "rejected", reason: "native_invalid", source, target });
    const exclusion = imageEnhancementExclusion(input);
    if (exclusion) return skipped(exclusion.reason);
    if (![target.width, target.height].every(positive)) return skipped("unsupported_target");
    const scale = Math.min(target.width / source.width, target.height / source.height);
    if (scale <= 1) return skipped("native_sufficient");
    if (source.provenance === "ai_enhanced") return skipped("already_enhanced");
    if (source.hasAlpha) return skipped("unsupported_transparency");
    if (!["png", "jpeg"].includes(source.format)) return skipped("unsupported_media_type");
    if (!input.connection) return skipped("provider_unavailable");
    const connection = Object.freeze({ ...input.connection, model: Object.freeze({ ...input.connection.model, allowedTiles: Object.freeze([...input.connection.model.allowedTiles]) }) });
    const inference = Object.freeze({ width: source.width * connection.model.nativeScale, height: source.height * connection.model.nativeScale });
    if (![inference.width, inference.height].every(positive) || scale > connection.model.nativeScale) return skipped("unsupported_target");
    return Object.freeze({ status: "queued", reason: null, source, target, connection, inference });
}
