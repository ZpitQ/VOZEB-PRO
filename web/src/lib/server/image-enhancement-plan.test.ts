import { describe, expect, it } from "vitest";
import { planImageEnhancement, type EnhancementPlanningInput } from "./image-enhancement-plan";

function fixture(): EnhancementPlanningInput {
    return {
        nativeValid: true,
        enabled: true,
        requested4k: true,
        protectedContract: false,
        layered: false,
        source: { url: "/api/generation-log-assets/images/fixture.png", sha256: "a".repeat(64), width: 1254, height: 1254, byteLength: 1000, format: "png", hasAlpha: false, provenance: "provider_native" },
        target: { width: 4096, height: 4096 },
        connection: { revision: "fixture-revision", credentialRef: "fixture-profile", serviceId: "31313131-3131-4131-8131-313131313131", timeoutMs: 10000, model: { id: "fixture-model", binaryVersion: "v1", binarySha256: "b".repeat(64), modelVersion: "v1", modelSha256: "c".repeat(64), nativeScale: 4, allowedTiles: [0], defaultTile: 0, tta: false, gpuId: 0 } },
    };
}

describe("ordinary-image enhancement planning", () => {
    it.each([
        [1254, 1254, 4096, 4096, 5016, 5016],
        [1600, 900, 3840, 2160, 6400, 3600],
        [1280, 720, 3840, 2160, 5120, 2880],
        [720, 1280, 2160, 3840, 2880, 5120],
    ])("keeps native, native AI and delivery dimensions separate: %sx%s", (width, height, targetWidth, targetHeight, aiWidth, aiHeight) => {
        const input = fixture();
        input.source = { ...input.source, width, height };
        input.target = { width: targetWidth, height: targetHeight };
        expect(planImageEnhancement(input)).toMatchObject({ status: "queued", reason: null, source: { width, height }, inference: { width: aiWidth, height: aiHeight }, target: { width: targetWidth, height: targetHeight } });
    });
    it.each([
        [{ enabled: false }, "disabled"],
        [{ requested4k: false }, "not_requested"],
        [{ protectedContract: true }, "protected_contract"],
        [{ layered: true }, "unsupported_layers"],
        [{ connection: null }, "provider_unavailable"],
    ] as const)("skips deterministically: %s", (patch, reason) => {
        expect(planImageEnhancement({ ...fixture(), ...patch })).toMatchObject({ status: "skipped", reason });
    });
    it("keeps enough native pixels and their provenance without another enhancement", () => {
        const input = fixture();
        input.source = { ...input.source, width: 4096, height: 4096, provenance: "ai_enhanced" };
        expect(planImageEnhancement(input)).toMatchObject({ status: "skipped", reason: "native_sufficient", source: input.source });
    });
    it("does not chain another 4x when an enhanced source is insufficient", () => {
        const input = fixture();
        input.source = { ...input.source, provenance: "ai_enhanced" };
        expect(planImageEnhancement(input)).toMatchObject({ status: "skipped", reason: "already_enhanced" });
    });
    it("skips transparent content without losing its native asset", () => {
        const input = fixture();
        input.source = { ...input.source, hasAlpha: true };
        expect(planImageEnhancement(input)).toMatchObject({ status: "skipped", reason: "unsupported_transparency", source: { url: input.source.url, sha256: input.source.sha256 } });
    });
    it("skips media unsupported by the actual Worker protocol", () => {
        const input = fixture();
        input.source = { ...input.source, format: "webp" };
        expect(planImageEnhancement(input)).toMatchObject({ status: "skipped", reason: "unsupported_media_type" });
    });
    it.each([{ enabled: false }, { requested4k: false }, { protectedContract: true }, { layered: true }])("rejects failed native validation before any exclusion: %s", (patch) => {
        expect(planImageEnhancement({ ...fixture(), nativeValid: false, ...patch })).toMatchObject({ status: "rejected", reason: "native_invalid" });
    });
    it("rejects invalid decoded native facts rather than publishing a fallback", () => {
        const input = fixture();
        input.source = { ...input.source, width: 0 };
        expect(planImageEnhancement(input)).toMatchObject({ status: "rejected", reason: "native_invalid" });
    });
    it.each([[1672, 941], [941, 1672], [1000, 700]])("preserves the original aspect inside the requested 4K boundary: %sx%s", (width, height) => {
        const input = fixture();
        input.source = { ...input.source, width, height };
        input.target = width >= height ? { width: 3840, height: 2160 } : { width: 2160, height: 3840 };
        expect(planImageEnhancement(input)).toMatchObject({ status: "queued", reason: null, source: input.source, target: input.target, inference: { width: width * 4, height: height * 4 } });
    });
    it("keeps an already sufficient wide original without cropping or another inference", () => {
        const input = fixture();
        input.source = { ...input.source, width: 8192, height: 1024 };
        expect(planImageEnhancement(input)).toMatchObject({ status: "skipped", reason: "native_sufficient" });
    });
    it("does not invent another native scale to reach an unsupported target", () => {
        expect(planImageEnhancement({ ...fixture(), target: { width: 8192, height: 8192 } })).toMatchObject({ status: "skipped", reason: "unsupported_target" });
    });
    it("freezes independent source, target and engine policy without modifying input", () => {
        const input = fixture();
        const before = JSON.stringify(input);
        const decision = planImageEnhancement(input);
        expect(JSON.stringify(input)).toBe(before);
        expect(Object.isFrozen(decision)).toBe(true);
        expect(Object.isFrozen(decision.source)).toBe(true);
        expect(Object.isFrozen(decision.target)).toBe(true);
        input.source.sha256 = "d".repeat(64);
        input.target.width = 2048;
        expect(decision.source.sha256).toBe("a".repeat(64));
        expect(decision.target.width).toBe(4096);
        expect(decision.status).toBe("queued");
        if (decision.status === "queued") {
            expect(decision.connection).not.toBe(input.connection);
            expect(Object.isFrozen(decision.connection.model.allowedTiles)).toBe(true);
            expect(JSON.stringify(decision)).not.toMatch(/token|endpoint|password/i);
        }
    });
});
