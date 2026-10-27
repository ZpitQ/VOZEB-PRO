import type { EnhancementCheck, EnhancementModel } from "@/lib/image-enhancement-contract";
import { readJsonDataFile, withJsonDataFileLock, writeJsonDataFile } from "@/lib/server/data-adapter";
import { ensurePostgresSchema, getDatabaseProvider, postgresQuery, withPostgresTransaction } from "@/lib/server/database/postgres";

export type EnhancementConnectionProfile = {
    id: string;
    endpoint: string;
    trust: "system" | "custom_ca";
    caPem: string;
    tokenCiphertext: string;
    credentialRevision: string;
    serviceId: string | null;
};
export type StoredImageEnhancementSettings = {
    revision: string;
    enabled: boolean;
    tta: boolean;
    profileId: string;
    profiles: Record<string, EnhancementConnectionProfile>;
    timeoutMs: number | null;
    modelId: string;
    models: EnhancementModel[];
    check: EnhancementCheck | null;
    checkRunId: string | null;
};
const fileName = "image-enhancement-settings.json";
function defaults(): StoredImageEnhancementSettings {
    return {
        revision: "initial",
        enabled: false,
        tta: false,
        profileId: "initial",
        profiles: { initial: { id: "initial", endpoint: "", trust: "system", caPem: "", tokenCiphertext: "", credentialRevision: "initial", serviceId: null } },
        timeoutMs: null,
        modelId: "",
        models: [],
        check: null,
        checkRunId: null,
    };
}
export async function readImageEnhancementSettings(): Promise<StoredImageEnhancementSettings> {
    if (getDatabaseProvider() !== "postgres") return readJsonDataFile(fileName, defaults());
    await ensurePostgresSchema();
    const result = await postgresQuery("SELECT value FROM image_enhancement_settings WHERE id = 'default'");
    return (result.rows[0]?.value as StoredImageEnhancementSettings) ?? defaults();
}
// Keep the read/modify/write boundary shared by Web and generation Worker processes.
export async function mutateImageEnhancementSettings<T>(update: (settings: StoredImageEnhancementSettings) => T): Promise<T> {
    if (getDatabaseProvider() !== "postgres")
        return withJsonDataFileLock(fileName, async () => {
            const settings = await readJsonDataFile(fileName, defaults());
            const result = update(settings);
            await writeJsonDataFile(fileName, settings);
            return result;
        });
    await ensurePostgresSchema();
    return withPostgresTransaction(async (client) => {
        await client.query("INSERT INTO image_enhancement_settings (id, value) VALUES ('default', $1::jsonb) ON CONFLICT (id) DO NOTHING", [JSON.stringify(defaults())]);
        const selected = await client.query("SELECT value FROM image_enhancement_settings WHERE id = 'default' FOR UPDATE");
        const settings = selected.rows[0]!.value as StoredImageEnhancementSettings;
        const result = update(settings);
        await client.query("UPDATE image_enhancement_settings SET value = $1::jsonb WHERE id = 'default'", [JSON.stringify(settings)]);
        return result;
    });
}
