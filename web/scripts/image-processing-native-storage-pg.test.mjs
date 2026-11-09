import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const enabled = process.env.VOZEB_PRO_RUN_ECOMMERCE_POSTGRES_INTEGRATION === "1" && process.env.VOZEB_PRO_ECOMMERCE_ISOLATED_DATABASE === "1";
const ownerUserId = "fixture-native-storage-pg-owner";
const nativeSha256 = "a8faed6abbf35c12a4b26e40f6feb19d736d90045c83b9f9a31f638d323e6811";

describe.skipIf(!enabled)("isolated native attachment PostgreSQL storage", () => {
    let context;
    let observer;

    beforeAll(async () => {
        expect(process.env.VOZEB_PRO_DATABASE_PROVIDER).toBe("postgres");
        expect(process.env.VOZEB_PRO_RUN_ECOMMERCE_POSTGRES_INTEGRATION).toBe("1");
        expect(process.env.VOZEB_PRO_ECOMMERCE_ISOLATED_DATABASE).toBe("1");
        expect(process.env.VOZEB_PRO_DATABASE_POOL_MAX).toBe("1");
        expect(process.env.DATABASE_URL).toBeTypeOf("string");
        expect(process.env.VOZEB_PRO_NATIVE_STORAGE_PG_CONTEXT).toBeTypeOf("string");
        context = JSON.parse(await readFile(process.env.VOZEB_PRO_NATIVE_STORAGE_PG_CONTEXT, "utf8"));
        expect(isAbsolute(context.dataDir)).toBe(true);
        expect(isAbsolute(context.observationsDir)).toBe(true);
        expect(process.env.VOZEB_PRO_DATA_DIR).toBe(context.dataDir);
        vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "a".repeat(64));
        observer = new Client({ connectionString: process.env.DATABASE_URL });
        await observer.connect();
        const identity = await observer.query('SELECT datname AS "databaseName", oid::text AS "databaseOid" FROM pg_database WHERE datname = current_database()');
        expect(identity.rows).toEqual([{ databaseName: context.databaseName, databaseOid: context.databaseOid }]);
    });

    afterAll(async () => {
        try {
            if (observer) await observer.end();
        } finally {
            vi.unstubAllEnvs();
        }
    });

    async function observation(name) {
        return JSON.parse(await readFile(join(context.observationsDir, name), "utf8"));
    }

    function saveObservation(name, value) {
        return writeFile(join(context.observationsDir, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    }

    async function snapshot() {
        const result = await observer.query(
            `SELECT jsonb_build_object(
                'identity', (SELECT jsonb_build_object('databaseName', datname, 'databaseOid', oid::text) FROM pg_database WHERE datname = current_database()),
                'mediaTable', (SELECT jsonb_build_object('oid', c.oid::text, 'schema', n.nspname, 'name', c.relname)
                    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = 'public.vozeb_pro_local_media_assets'::regclass),
                'typeChecks', (SELECT coalesce(jsonb_agg(jsonb_build_object('oid', c.oid::text, 'name', c.conname, 'definition', pg_get_constraintdef(c.oid), 'validated', c.convalidated) ORDER BY c.conname), '[]'::jsonb)
                    FROM pg_constraint c WHERE c.conrelid = 'public.vozeb_pro_local_media_assets'::regclass AND c.contype = 'c' AND c.conname = 'local_media_assets_type'),
                'otherChecks', (SELECT coalesce(jsonb_agg(jsonb_build_object('oid', c.oid::text, 'name', c.conname, 'definition', pg_get_constraintdef(c.oid), 'validated', c.convalidated) ORDER BY c.conname), '[]'::jsonb)
                    FROM pg_constraint c WHERE c.conrelid = 'public.vozeb_pro_local_media_assets'::regclass AND c.contype = 'c' AND c.conname <> 'local_media_assets_type'),
                'controlRows', (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.storage_key), '[]'::jsonb)
                    FROM public.vozeb_pro_local_media_assets a WHERE a.owner_user_id = $1 AND a.source = 'native-storage-pg-control'),
                'allMediaRows', (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.storage_key), '[]'::jsonb)
                    FROM public.vozeb_pro_local_media_assets a),
                'migrations', (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.version), '[]'::jsonb) FROM public.vozeb_pro_schema_migrations m),
                'migrationVersions', (SELECT coalesce(jsonb_agg(m.version ORDER BY m.version), '[]'::jsonb) FROM public.vozeb_pro_schema_migrations m),
                'bootstrapRows', (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.version), '[]'::jsonb)
                    FROM public.vozeb_pro_schema_migrations m WHERE m.version LIKE 'bootstrap-sha256:%'),
                'otherMigrations', (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.version), '[]'::jsonb)
                    FROM public.vozeb_pro_schema_migrations m WHERE m.version NOT LIKE 'bootstrap-sha256:%')
            ) AS snapshot`,
            [ownerUserId],
        );
        return result.rows[0].snapshot;
    }

    function expectCurrentSchema(value) {
        expect(value.identity).toEqual({ databaseName: context.databaseName, databaseOid: context.databaseOid });
        expect(value.mediaTable).toMatchObject({ schema: "public", name: "vozeb_pro_local_media_assets" });
        expect(value.typeChecks).toHaveLength(1);
        expect(value.typeChecks[0]).toMatchObject({ name: "local_media_assets_type", validated: true });
        expect(value.typeChecks[0].definition).toContain("'image'");
        expect(value.typeChecks[0].definition).toContain("'video'");
        expect(value.typeChecks[0].definition).toContain("'audio'");
        expect(value.typeChecks[0].definition).toContain("'attachment'");
    }

    it("bootstrap-only initializes an empty database and records its current fingerprint with ordinary media controls", async () => {
        const empty = await observer.query("SELECT to_regclass('public.vozeb_pro_users')::text AS users, to_regclass('public.vozeb_pro_local_media_assets')::text AS media, to_regclass('public.vozeb_pro_schema_migrations')::text AS migrations");
        expect(empty.rows).toEqual([{ users: null, media: null, migrations: null }]);
        const database = await import("../src/lib/server/database/index.ts");
        await database.initializePostgresSchema();
        const { getObjectStorageRuntimeConfig } = await import("../src/lib/server/object-storage-config.ts");
        expect((await getObjectStorageRuntimeConfig()).enabled).toBe(false);
        expect((await observer.query("SELECT id FROM public.vozeb_pro_entitlement_plans WHERE id = 'free'")).rows).toEqual([{ id: "free" }]);
        await database.createPostgresRepositories().users.createWithNextAccountId({
            id: ownerUserId,
            username: "fixture_native_storage_pg",
            displayName: "Isolated native storage fixture",
            bio: "",
            role: "user",
            adminPermissions: [],
            status: "active",
            planId: "free",
            pointsBalance: 1000,
            passwordHash: "fixture-only",
            createdAt: "2026-10-28T00:00:00.000Z",
            updatedAt: "2026-10-28T00:00:00.000Z",
        });
        const { registerLocalMediaAsset } = await import("../src/lib/server/local-media-registry.ts");
        const control = { scope: "reference", storageClass: "permanent", ownerUserId, source: "native-storage-pg-control", createdAt: "2026-10-28T00:00:00.000Z" };
        await registerLocalMediaAsset({ ...control, storageKey: "permanent/native-pg-control-image.png", type: "image", mimeType: "image/png", bytes: 2 });
        await registerLocalMediaAsset({ ...control, storageKey: "permanent/native-pg-control-video.mp4", type: "video", mimeType: "video/mp4", bytes: 3 });
        await registerLocalMediaAsset({ ...control, storageKey: "permanent/native-pg-control-audio.mp3", type: "audio", mimeType: "audio/mpeg", bytes: 4 });
        const initialized = await snapshot();
        expectCurrentSchema(initialized);
        expect(initialized.bootstrapRows).toHaveLength(1);
        expect(initialized.bootstrapRows[0].version).toMatch(/^bootstrap-sha256:[a-f0-9]{64}$/);
        expect(initialized.allMediaRows).toHaveLength(3);
        expect(initialized.controlRows).toMatchObject([
            { storage_key: "permanent/native-pg-control-audio.mp3", type: "audio", owner_user_id: ownerUserId, storage_provider: "local", bytes: 4 },
            { storage_key: "permanent/native-pg-control-image.png", type: "image", owner_user_id: ownerUserId, storage_provider: "local", bytes: 2 },
            { storage_key: "permanent/native-pg-control-video.mp4", type: "video", owner_user_id: ownerUserId, storage_provider: "local", bytes: 3 },
        ]);
        await saveObservation("bootstrap.json", { ownerUserId, vCurrent: initialized.bootstrapRows[0].version, snapshot: initialized });
    });

    it("ensures the prepared database and round-trips a closed opaque attachment through the actual writer and PostgreSQL registry", async () => {
        const bootstrap = await observation("bootstrap.json");
        const beforeEnsure = await snapshot();
        expect(beforeEnsure.identity).toEqual({ databaseName: context.databaseName, databaseOid: context.databaseOid });
        expect(beforeEnsure.mediaTable).toEqual(bootstrap.snapshot.mediaTable);
        expect(beforeEnsure.typeChecks).toHaveLength(1);
        expect(beforeEnsure.typeChecks[0].definition).toBe(context.expectedTypeCheckBeforeEnsure);
        expect(beforeEnsure.bootstrapRows).toHaveLength(context.expectedBootstrapCountBeforeEnsure);
        const currentBefore = await observer.query("SELECT version FROM public.vozeb_pro_schema_migrations WHERE version = $1", [bootstrap.vCurrent]);
        expect(currentBefore.rows).toHaveLength(context.expectedBootstrapCountBeforeEnsure);
        expect(beforeEnsure.controlRows).toEqual(bootstrap.snapshot.controlRows);
        expect(beforeEnsure.otherChecks).toEqual(bootstrap.snapshot.otherChecks);
        expect(beforeEnsure.otherMigrations).toEqual(bootstrap.snapshot.otherMigrations);
        expect(beforeEnsure.allMediaRows).toHaveLength(3);
        await saveObservation("before-ensure.json", beforeEnsure);

        const { ensurePostgresSchema } = await import("../src/lib/server/database/postgres.ts");
        await ensurePostgresSchema();
        const afterEnsure = await snapshot();
        expectCurrentSchema(afterEnsure);
        expect(afterEnsure.mediaTable).toEqual(beforeEnsure.mediaTable);
        expect(afterEnsure.otherChecks).toEqual(beforeEnsure.otherChecks);
        expect(afterEnsure.controlRows).toEqual(beforeEnsure.controlRows);
        expect(afterEnsure.allMediaRows).toEqual(beforeEnsure.allMediaRows);
        expect(afterEnsure.otherMigrations).toEqual(beforeEnsure.otherMigrations);
        expect(afterEnsure.bootstrapRows).toHaveLength(1);
        expect(afterEnsure.bootstrapRows[0].version).toBe(bootstrap.vCurrent);
        const preservedMigrations = await observer.query("SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.version), '[]'::jsonb) AS rows FROM public.vozeb_pro_schema_migrations m WHERE m.version = ANY($1::text[])", [beforeEnsure.migrationVersions]);
        expect(preservedMigrations.rows[0].rows).toEqual(beforeEnsure.migrations);

        const { getObjectStorageRuntimeConfig } = await import("../src/lib/server/object-storage-config.ts");
        const { writeReferenceMediaFile } = await import("../src/lib/server/reference-asset-store.ts");
        const { getLocalMediaRegistration } = await import("../src/lib/server/local-media-registry.ts");
        const { REFERENCE_MEDIA_ROOT } = await import("../src/lib/server/local-media-storage.ts");
        expect((await getObjectStorageRuntimeConfig()).enabled).toBe(false);
        expect(REFERENCE_MEDIA_ROOT).toBe(join(context.dataDir, "reference-assets"));
        const originalBytes = Buffer.from("00112233445566778899aabbccddeeff", "hex");
        const originalName = "native-pg-original.bin";
        const sourcePath = join(context.dataDir, originalName);
        await writeFile(sourcePath, originalBytes, { flag: "wx" });
        const stored = await writeReferenceMediaFile(sourcePath, "attachment", "application/octet-stream", true, { ownerUserId: bootstrap.ownerUserId, source: "image-processing-native", originalName });
        expect(stored).toMatchObject({ bytes: 16, mimeType: "application/octet-stream", storage: "local" });
        expect(stored.token).toMatch(/^permanent\/\d{4}\/\d{2}\/\d{2}\/attachments\/[^/]+\.bin$/);
        const registration = await getLocalMediaRegistration(stored.token);
        expect(registration).toMatchObject({
            storageKey: stored.token,
            scope: "reference",
            storageClass: "permanent",
            type: "attachment",
            ownerUserId: bootstrap.ownerUserId,
            source: "image-processing-native",
            originalName,
            mimeType: "application/octet-stream",
            bytes: 16,
            storageProvider: "local",
        });
        expect(registration.expiresAt).toBeUndefined();
        const rawResult = await observer.query("SELECT to_jsonb(a) AS row FROM public.vozeb_pro_local_media_assets a WHERE a.storage_key = $1", [stored.token]);
        expect(rawResult.rows).toHaveLength(1);
        const rawRow = rawResult.rows[0].row;
        expect(rawRow).toMatchObject({
            storage_key: stored.token,
            scope: "reference",
            storage_class: "permanent",
            type: "attachment",
            owner_user_id: bootstrap.ownerUserId,
            source: "image-processing-native",
            original_name: originalName,
            mime_type: "application/octet-stream",
            bytes: 16,
            storage_provider: "local",
            expires_at: null,
        });
        const storedPath = resolve(REFERENCE_MEDIA_ROOT, stored.token);
        const storedBytes = await readFile(storedPath);
        expect(storedBytes.equals(originalBytes)).toBe(true);
        expect(createHash("sha256").update(storedBytes).digest("hex")).toBe(nativeSha256);
        const sourceAfter = await readFile(sourcePath);
        expect(sourceAfter.equals(originalBytes)).toBe(true);
        expect(createHash("sha256").update(sourceAfter).digest("hex")).toBe(nativeSha256);
        const afterRoundTrip = await snapshot();
        expect(afterRoundTrip.controlRows).toEqual(beforeEnsure.controlRows);
        expect(afterRoundTrip.migrations).toEqual(afterEnsure.migrations);
        expect(afterRoundTrip.allMediaRows).toHaveLength(4);
        await saveObservation("roundtrip.json", { ownerUserId: bootstrap.ownerUserId, vCurrent: bootstrap.vCurrent, beforeEnsure, afterEnsure, afterRoundTrip, stored, registration, rawRow, sourcePath, storedPath });
    });

    it("keeps the applied fingerprint, controls, registered attachment and original files unchanged on a fresh ensure fast path", async () => {
        const saved = await observation("roundtrip.json");
        const beforeEnsure = await snapshot();
        expect(beforeEnsure).toEqual(saved.afterRoundTrip);
        const { ensurePostgresSchema } = await import("../src/lib/server/database/postgres.ts");
        await ensurePostgresSchema();
        const afterEnsure = await snapshot();
        expect(afterEnsure).toEqual(saved.afterRoundTrip);
        expectCurrentSchema(afterEnsure);
        expect(afterEnsure.bootstrapRows).toHaveLength(1);
        expect(afterEnsure.bootstrapRows[0].version).toBe(saved.vCurrent);
        const { getLocalMediaRegistration } = await import("../src/lib/server/local-media-registry.ts");
        const { REFERENCE_MEDIA_ROOT } = await import("../src/lib/server/local-media-storage.ts");
        expect(REFERENCE_MEDIA_ROOT).toBe(join(context.dataDir, "reference-assets"));
        expect(resolve(REFERENCE_MEDIA_ROOT, saved.stored.token)).toBe(saved.storedPath);
        expect(await getLocalMediaRegistration(saved.stored.token)).toEqual(saved.registration);
        const rawResult = await observer.query("SELECT to_jsonb(a) AS row FROM public.vozeb_pro_local_media_assets a WHERE a.storage_key = $1", [saved.stored.token]);
        expect(rawResult.rows).toEqual([{ row: saved.rawRow }]);
        const originalBytes = Buffer.from("00112233445566778899aabbccddeeff", "hex");
        const storedBytes = await readFile(saved.storedPath);
        const sourceBytes = await readFile(saved.sourcePath);
        expect(storedBytes.equals(originalBytes)).toBe(true);
        expect(sourceBytes.equals(originalBytes)).toBe(true);
        expect(createHash("sha256").update(storedBytes).digest("hex")).toBe(nativeSha256);
        expect(createHash("sha256").update(sourceBytes).digest("hex")).toBe(nativeSha256);
        await saveObservation("fastpath.json", { beforeEnsure, afterEnsure, registration: saved.registration, rawRow: rawResult.rows[0].row, sourcePath: saved.sourcePath, storedPath: saved.storedPath });
    });
});
