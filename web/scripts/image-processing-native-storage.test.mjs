import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

let directory;

beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "vozeb-native-storage-"));
    vi.stubEnv("VOZEB_PRO_DATA_DIR", join(directory, "data"));
    vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
    vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "a".repeat(64));
});

afterAll(async () => {
    vi.unstubAllEnvs();
    if (directory) await rm(directory, { recursive: true, force: true });
});

it("stores a closed unknown native file as a permanent attachment without changing its bytes", async () => {
    const { getDatabaseProvider } = await import("../src/lib/server/database/postgres.ts");
    const { getObjectStorageRuntimeConfig } = await import("../src/lib/server/object-storage-config.ts");
    const { writeReferenceMediaFile } = await import("../src/lib/server/reference-asset-store.ts");
    const { getLocalMediaRegistration } = await import("../src/lib/server/local-media-registry.ts");
    const { REFERENCE_MEDIA_ROOT } = await import("../src/lib/server/local-media-storage.ts");
    expect(getDatabaseProvider()).toBe("file");
    expect((await getObjectStorageRuntimeConfig()).enabled).toBe(false);
    expect(REFERENCE_MEDIA_ROOT).toBe(join(directory, "data", "reference-assets"));

    const originalBytes = Buffer.from([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]);
    const originalName = "native-output.bin";
    const sourcePath = join(directory, originalName);
    const ownerUserId = `fixture-native-storage-${randomUUID()}`;
    await writeFile(sourcePath, originalBytes, { flag: "wx" });

    const stored = await writeReferenceMediaFile(sourcePath, "attachment", "application/octet-stream", true, {
        ownerUserId,
        source: "image-processing-native",
        originalName,
    });

    expect(stored).toMatchObject({ bytes: 16, mimeType: "application/octet-stream", storage: "local" });
    expect(stored.token).toMatch(/^permanent\/\d{4}\/\d{2}\/\d{2}\/attachments\/[^/]+\.bin$/);
    const registration = await getLocalMediaRegistration(stored.token);
    expect(registration).toMatchObject({
        storageKey: stored.token,
        scope: "reference",
        storageClass: "permanent",
        type: "attachment",
        ownerUserId,
        source: "image-processing-native",
        originalName,
        mimeType: "application/octet-stream",
        bytes: 16,
        storageProvider: "local",
    });
    expect(registration.expiresAt).toBeUndefined();

    const storedBytes = await readFile(resolve(REFERENCE_MEDIA_ROOT, registration.storageKey));
    expect(storedBytes).toEqual(originalBytes);
    expect(createHash("sha256").update(storedBytes).digest("hex")).toBe("a8faed6abbf35c12a4b26e40f6feb19d736d90045c83b9f9a31f638d323e6811");
    expect(await readFile(sourcePath)).toEqual(originalBytes);
});
