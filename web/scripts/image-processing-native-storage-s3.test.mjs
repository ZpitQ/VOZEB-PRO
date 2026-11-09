import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

let directory;

beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "vozeb-native-storage-s3-"));
    vi.stubEnv("VOZEB_PRO_DATA_DIR", join(directory, "data"));
    vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
    vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "a".repeat(64));
});

afterAll(async () => {
    try {
        if (directory) await rm(directory, { recursive: true, force: true });
    } finally {
        vi.unstubAllEnvs();
    }
});

async function withNativeS3Storage(check) {
    const { getDatabaseProvider } = await import("../src/lib/server/database/postgres.ts");
    const config = await import("../src/lib/server/object-storage-config.ts");
    const repository = await import("../src/lib/server/database/object-storage-repository.ts");
    const { imageProcessingS3Fixture } = await import("../src/lib/server/image-processing-s3-fixture.ts");
    const { REFERENCE_MEDIA_ROOT } = await import("../src/lib/server/local-media-storage.ts");
    expect(getDatabaseProvider()).toBe("file");
    expect(REFERENCE_MEDIA_ROOT).toBe(join(directory, "data", "reference-assets"));
    const originalSettings = await repository.readObjectStorageSettings();
    const fixture = await imageProcessingS3Fixture();
    try {
        await config.saveObjectStorageAdminSettings(fixture.config);
        await check({ fixture, config, referenceRoot: REFERENCE_MEDIA_ROOT });
    } finally {
        try {
            await fixture.close();
        } finally {
            await repository.writeObjectStorageSettings(originalSettings);
            await config.getObjectStorageAdminSettings();
        }
    }
}

it("stores and streams a closed opaque file above 20MiB through real S3 without a permanent local copy", async () => {
    const { writeReferenceMediaFile } = await import("../src/lib/server/reference-asset-store.ts");
    const { getLocalMediaRegistration } = await import("../src/lib/server/local-media-registry.ts");
    const { readExternalMediaStream } = await import("../src/lib/server/object-storage-service.ts");
    const { imageProcessingStreamBytes } = await import("../src/lib/server/image-processing-s3-fixture.ts");
    // A fixed non-image payload makes both the cap boundary and full-file digest reproducible.
    const originalBytes = Buffer.alloc(20971521, 0xa5);
    const originalName = "native-above-20mib.bin";
    const sourcePath = join(directory, originalName);
    const ownerUserId = `fixture-native-s3-large-${randomUUID()}`;
    await writeFile(sourcePath, originalBytes, { flag: "wx" });
    expect((await stat(sourcePath)).size).toBe(20971521);

    await withNativeS3Storage(async ({ fixture, referenceRoot }) => {
        const stored = await writeReferenceMediaFile(sourcePath, "attachment", "application/octet-stream", true, {
            ownerUserId,
            source: "image-processing-native",
            originalName,
        });
        expect(stored).toMatchObject({ bytes: 20971521, mimeType: "application/octet-stream", storage: "object" });
        expect(stored.token).toMatch(/^permanent\/\d{4}\/\d{2}\/\d{2}\/attachments\/[^/]+\.bin$/);
        const registration = await getLocalMediaRegistration(stored.token);
        const objectKey = `fixture/media/reference/${stored.token}`;
        expect(registration).toMatchObject({
            storageKey: stored.token,
            scope: "reference",
            storageClass: "permanent",
            type: "attachment",
            ownerUserId,
            source: "image-processing-native",
            originalName,
            mimeType: "application/octet-stream",
            bytes: 20971521,
            storageProvider: "object",
            externalStorageId: "default",
            externalObjectKey: objectKey,
        });
        expect(registration.expiresAt).toBeUndefined();
        expect(fixture.requests).toEqual([{ method: "PUT", key: objectKey }]);
        expect(fixture.contentTypes.get(objectKey)).toBe("application/octet-stream");
        await expect(stat(resolve(referenceRoot, stored.token))).rejects.toMatchObject({ code: "ENOENT" });

        const transfer = fixture.control(objectKey);
        const stream = await readExternalMediaStream(registration);
        await transfer.headers;
        expect(transfer.connectionClosed).toBe(false);
        const iterator = stream[Symbol.asyncIterator]();
        transfer.releaseFirst();
        const first = await iterator.next();
        expect(first.done).toBe(false);
        expect(Buffer.from(first.value).equals(Buffer.from([0xa5]))).toBe(true);
        expect(transfer.connectionClosed).toBe(false);
        transfer.releaseEnd();
        const actualBytes = Buffer.concat([Buffer.from(first.value), await imageProcessingStreamBytes(iterator)]);
        await transfer.closed;
        expect(transfer.connectionClosed).toBe(true);
        expect(actualBytes.length).toBe(20971521);
        expect(actualBytes.equals(originalBytes)).toBe(true);
        expect(createHash("sha256").update(actualBytes).digest("hex")).toBe("00bd61af5db1dfc73668c2eed6533822511b4e7a326d9754113274914f61af0f");
        expect(fixture.requests).toEqual([
            { method: "PUT", key: objectKey },
            { method: "GET", key: objectKey },
        ]);
        expect(await getLocalMediaRegistration(stored.token)).toEqual(registration);
        await expect(stat(resolve(referenceRoot, stored.token))).rejects.toMatchObject({ code: "ENOENT" });
        const sourceAfter = await readFile(sourcePath);
        expect(sourceAfter.length).toBe(20971521);
        expect(sourceAfter.equals(originalBytes)).toBe(true);
        expect(createHash("sha256").update(sourceAfter).digest("hex")).toBe("00bd61af5db1dfc73668c2eed6533822511b4e7a326d9754113274914f61af0f");
    });
});

it("reads the registered opaque S3 original after new object writes are disabled without another PUT", async () => {
    const { writeReferenceMediaFile } = await import("../src/lib/server/reference-asset-store.ts");
    const { getLocalMediaRegistration } = await import("../src/lib/server/local-media-registry.ts");
    const { readExternalMediaStream } = await import("../src/lib/server/object-storage-service.ts");
    const { imageProcessingStreamBytes } = await import("../src/lib/server/image-processing-s3-fixture.ts");
    const originalBytes = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const originalName = "native-historical-object.bin";
    const sourcePath = join(directory, originalName);
    const ownerUserId = `fixture-native-s3-historical-${randomUUID()}`;
    await writeFile(sourcePath, originalBytes, { flag: "wx" });

    await withNativeS3Storage(async ({ fixture, config, referenceRoot }) => {
        const stored = await writeReferenceMediaFile(sourcePath, "attachment", "application/octet-stream", true, {
            ownerUserId,
            source: "image-processing-native",
            originalName,
        });
        expect(stored).toMatchObject({ bytes: 16, mimeType: "application/octet-stream", storage: "object" });
        const registration = await getLocalMediaRegistration(stored.token);
        const objectKey = `fixture/media/reference/${stored.token}`;
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
            storageProvider: "object",
            externalStorageId: "default",
            externalObjectKey: objectKey,
        });
        expect(registration.expiresAt).toBeUndefined();
        expect(fixture.contentTypes.get(objectKey)).toBe("application/octet-stream");
        expect(fixture.requests).toEqual([{ method: "PUT", key: objectKey }]);
        const registeredBeforeRead = structuredClone(registration);

        await config.saveObjectStorageAdminSettings({ ...fixture.config, enabled: false });
        expect((await config.getObjectStorageRuntimeConfig()).enabled).toBe(false);
        const actualBytes = await imageProcessingStreamBytes(await readExternalMediaStream(registration));
        expect(actualBytes.length).toBe(16);
        expect(actualBytes.equals(originalBytes)).toBe(true);
        expect(createHash("sha256").update(actualBytes).digest("hex")).toBe("a8faed6abbf35c12a4b26e40f6feb19d736d90045c83b9f9a31f638d323e6811");
        expect(fixture.requests).toEqual([
            { method: "PUT", key: objectKey },
            { method: "GET", key: objectKey },
        ]);
        expect(await getLocalMediaRegistration(stored.token)).toEqual(registeredBeforeRead);
        await expect(stat(resolve(referenceRoot, stored.token))).rejects.toMatchObject({ code: "ENOENT" });
        expect((await readFile(sourcePath)).equals(originalBytes)).toBe(true);
    });
});
