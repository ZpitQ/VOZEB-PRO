import { beforeAll, describe, expect, it } from "vitest";
import { initializePostgresSchema, postgresQuery } from "@/lib/server/database/postgres";
import { getImageEnhancementSettings, saveImageEnhancementSettings } from "@/lib/server/image-enhancement-config";
import { mutateImageEnhancementSettings, readImageEnhancementSettings } from "./image-enhancement-repository";

const enabled = process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION === "1" && process.env.VOZEB_PRO_ECOMMERCE_ISOLATED_DATABASE === "1";
describe.skipIf(!enabled)("isolated PostgreSQL enhancement settings", () => {
    beforeAll(async () => {
        const target = new URL(process.env.DATABASE_URL || "");
        if (process.env.VOZEB_PRO_DATABASE_PROVIDER !== "postgres" || target.hostname !== "127.0.0.1" || target.port !== "32782" || !target.pathname.endsWith("_m4_e2e")) throw new Error("An explicitly isolated M4 PostgreSQL fixture is required");
        await initializePostgresSchema();
    });
    it("starts disabled without a Worker dependency", async () => {
        expect(await getImageEnhancementSettings()).toMatchObject({ enabled: false, ready: false, hasToken: false });
    });
    it("immediately round-trips encrypted credentials through actual PostgreSQL", async () => {
        const before = await getImageEnhancementSettings();
        const saved = await saveImageEnhancementSettings({ revision: before.revision, endpoint: "http://localhost:1", token: "fixture-pg-enhancement-access", timeoutMs: 10_000 });
        expect(await getImageEnhancementSettings()).toEqual(saved);
        const row = (await postgresQuery("SELECT value FROM image_enhancement_settings WHERE id = 'default'")).rows[0]!.value;
        expect(JSON.stringify(row)).not.toContain("fixture-pg-enhancement-access");
        expect(JSON.stringify(row)).toContain("vozeb-pro-secret:v1:");
        const preserved = await saveImageEnhancementSettings({ revision: saved.revision, token: "" });
        expect(preserved).toEqual(saved);
    });
    it("serializes concurrent revision changes without lost writes", async () => {
        const before = await getImageEnhancementSettings();
        const results = await Promise.allSettled([20_000, 30_000].map((timeoutMs) => saveImageEnhancementSettings({ revision: before.revision, timeoutMs })));
        expect(results.filter((value) => value.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((value) => value.status === "rejected")).toMatchObject([{ reason: { code: "configuration_changed" } }]);
        const winner = results.find((value) => value.status === "fulfilled")!;
        expect(await getImageEnhancementSettings()).toEqual(winner.status === "fulfilled" ? winner.value : null);
    });
    it("rolls back a failed settings mutation", async () => {
        const before = await readImageEnhancementSettings();
        await expect(
            mutateImageEnhancementSettings((settings) => {
                settings.enabled = true;
                throw new Error("fixture rollback");
            }),
        ).rejects.toThrow("fixture rollback");
        expect(await readImageEnhancementSettings()).toEqual(before);
    });
    it("clears the stored credential and immediately reflects the result", async () => {
        const before = await getImageEnhancementSettings();
        const saved = await saveImageEnhancementSettings({ revision: before.revision, clearToken: true });
        expect(saved).toMatchObject({ hasToken: false, ready: false });
        expect(await getImageEnhancementSettings()).toEqual(saved);
        const stored = await readImageEnhancementSettings();
        expect(stored.profiles[stored.profileId]!.tokenCiphertext).toBe("");
    });
});
