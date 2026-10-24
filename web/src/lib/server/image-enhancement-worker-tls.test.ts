import { createServer, type Server } from "node:https";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getImageEnhancementSettings, saveImageEnhancementSettings, checkImageEnhancementSettings } from "./image-enhancement-config";

let directory: string;
let server: Server;
let endpoint: string;
let ca: string;
let key: string;
async function save(patch: Record<string, unknown>) {
    return saveImageEnhancementSettings({ revision: (await getImageEnhancementSettings()).revision, ...patch });
}
async function check() {
    return checkImageEnhancementSettings({ revision: (await getImageEnhancementSettings()).revision, action: "connection" });
}

describe("enhancement HTTPS identity and custom CA", () => {
    beforeAll(async () => {
        directory = await mkdtemp(join(tmpdir(), "enhancement-tls-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
        vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "5d".repeat(32));
        await promisify(execFile)("openssl", [
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "1",
            "-subj",
            "/CN=enhancement-fixture",
            "-addext",
            "subjectAltName=IP:127.0.0.1",
            "-keyout",
            join(directory, "key.pem"),
            "-out",
            join(directory, "cert.pem"),
        ]);
        [ca, key] = await Promise.all([readFile(join(directory, "cert.pem"), "utf8"), readFile(join(directory, "key.pem"), "utf8")]);
        server = createServer({ cert: ca, key }, (_req, res) => {
            res.setHeader("content-type", "application/json");
            res.end(
                JSON.stringify({
                    code: "ok",
                    data: {
                        serviceId: "31313131-3131-4131-8131-313131313131",
                        protocolVersion: "image-enhancement.v1",
                        normalizationProfile: "srgb-upright-v1",
                        ready: true,
                        models: [{ id: "fixture-model", binaryVersion: "v1", binarySha256: "a".repeat(64), modelVersion: "v1", modelSha256: "b".repeat(64), nativeScale: 4, allowedTiles: [0], defaultTile: 0, tta: false, gpuId: 0 }],
                    },
                }),
            );
        }).listen(0);
        await once(server, "listening");
        endpoint = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
    });
    afterAll(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
        vi.unstubAllEnvs();
    });
    it("refuses a self-signed server using ordinary system trust", async () => {
        await save({ endpoint, token: "fixture-tls-access", timeoutMs: 10_000 });
        expect((await check()).check).toMatchObject({ state: "unavailable", reason: "tls_untrusted" });
    });
    it("accepts the explicitly trusted certificate without disabling identity validation", async () => {
        await save({ trust: "custom_ca", caPem: ca });
        const result = await check();
        expect(result).toMatchObject({ hasCa: true, ready: false, check: { state: "pending", reason: "sample_required" } });
        expect(JSON.stringify(result)).not.toContain("BEGIN CERTIFICATE");
    });
    it("still refuses a wrong server name with the correct custom CA", async () => {
        await save({ endpoint: endpoint.replace("127.0.0.1", "localhost") });
        expect((await check()).check?.reason).toBe("tls_untrusted");
    });
    it("rejects private key material in a CA-only field", async () => {
        await expect(save({ caPem: key })).rejects.toMatchObject({ code: "invalid_configuration" });
    });
});
