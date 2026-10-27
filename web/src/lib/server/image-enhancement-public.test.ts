import { describe, expect, it } from "vitest";
import { publicImageEnhancement } from "./image-enhancement-public";
import type { ImageEnhancementJob } from "./database/image-enhancement-job-repository";
import { planImageEnhancement } from "./image-enhancement-plan";

function fixture(): ImageEnhancementJob {
    return {
        id: "enhancement:fixture:1",
        userId: "private-user",
        imageTaskId: "fixture",
        resultId: "fixture:1",
        decision: planImageEnhancement({
            nativeValid: true,
            enabled: true,
            requested4k: true,
            protectedContract: false,
            layered: false,
            source: { url: "/api/generation-log-assets/native.png", width: 1254, height: 1254, byteLength: 1000, sha256: "a".repeat(64), hasAlpha: false, format: "png", provenance: "provider_native" },
            target: { width: 4096, height: 4096 },
            connection: {
                revision: "private-revision",
                credentialRef: "private-credential",
                serviceId: "private-service",
                timeoutMs: 60_000,
                model: { id: "fixture-model", binaryVersion: "binary-v1", binarySha256: "b".repeat(64), modelVersion: "model-v1", modelSha256: "c".repeat(64), nativeScale: 4, allowedTiles: [0], defaultTile: 0, tta: false, gpuId: 0 },
            },
        }),
        status: "running",
        phase: "poll",
        reason: null,
        attempt: 1,
        remoteKey: "private-remote-key",
        remoteJobId: "private-remote-job",
        receiptId: "private-receipt",
        events: [{ stage: "prepared", at: 1000, attempt: 1 }],
        cancelRequested: false,
        createdAt: 1000,
        updatedAt: 2000,
        nextPollAt: 3000,
        workerId: "private-system-worker",
        leaseToken: "private-lease",
        leaseUntil: 90000,
    };
}
describe("public image enhancement summary", () => {
    it.each([false, true])("publishes the persisted TTA choice %s without consulting current settings", (tta) => {
        const job = fixture();
        if (job.decision.status !== "queued") throw new Error("expected queued fixture");
        job.decision = { ...job.decision, connection: { ...job.decision.connection, model: { ...job.decision.connection.model, tta } } };
        expect(publicImageEnhancement(job).model).toMatchObject({ id: "fixture-model", tta });
    });
    it("shows the qualified product original and raw native as separate identities without disclosing masks", () => {
        const job = fixture();
        const source = job.decision.source;
        const baseline = { ...source, url: "/api/generation-log-assets/product-base.png", sha256: "d".repeat(64) };
        job.decision = {
            ...job.decision,
            target: { width: 1254, height: 1254 },
            requestedTarget: { width: 4096, height: 4096 },
            delivery: {
                contract: {
                    version: "ecommerce-delivery.v2",
                    scope: "product_background",
                    baseline: { url: "/api/reference-assets/source.png", sha256: "e".repeat(64), width: 1254, height: 1254, byteLength: 1000, normalizedSha256: "f".repeat(64) },
                    protection: {
                        version: "product-enhancement.v2",
                        normalization: "srgb-upright-v1",
                        maskDataUrl: "private-mask-data",
                        maskSha256: "b".repeat(64),
                        product: { compilerVersion: "strict-product.v1", state: "ready", productAnchorId: "root", sourceAssetId: "source", sourceSize: { width: 1254, height: 1254 }, productCore: [], fusionHalo: [], editableBackground: [] },
                    },
                },
                baseline,
            },
        };
        const summary = publicImageEnhancement(job);
        expect(summary).toMatchObject({
            native: { url: baseline.url, sha256: baseline.sha256, provenance: "protected_composite" },
            providerNative: { url: source.url, sha256: source.sha256 },
            delivery: { version: "ecommerce-delivery.v2", scope: "product_background", requestedTarget: { width: 4096, height: 4096 } },
        });
        expect(JSON.stringify(summary)).not.toContain("private-");
        expect(summary).not.toHaveProperty("delivery.protectedChangedPixels");
    });
    it("publishes only finite measured timing fields for the current attempt", () => {
        const job = fixture();
        Object.assign(job, { timings: { workerQueueMs: 0, workerExecutionMs: 125.5, deliveryEncodingMs: 2.75, ownerDescriptor: "private-timing-descriptor", path: "private-timing-path" } });
        const summary = publicImageEnhancement(job);
        expect(summary).toHaveProperty("timings", { workerQueueMs: 0, workerExecutionMs: 125.5, deliveryEncodingMs: 2.75 });
        expect(JSON.stringify(summary)).not.toContain("private-");
        expect(publicImageEnhancement(fixture())).not.toHaveProperty("timings");
    });
    it.each(["12", -1, Number.NaN, Number.POSITIVE_INFINITY, null])("omits invalid persisted timing values instead of presenting them as measurements: %j", (value) => {
        const job = fixture();
        Object.assign(job, { timings: { workerQueueMs: value, workerExecutionMs: value, deliveryEncodingMs: value } });
        expect(publicImageEnhancement(job)).not.toHaveProperty("timings");
    });
    it("exposes actual native dimensions and distinguishes planned AI dimensions from delivered facts", () => {
        expect(publicImageEnhancement(fixture())).toMatchObject({
            imageTaskId: "fixture",
            resultId: "fixture:1",
            status: "running",
            phase: "poll",
            attempt: 1,
            native: { url: "/api/generation-log-assets/native.png", width: 1254, height: 1254, sha256: "a".repeat(64) },
            plannedInference: { width: 5016, height: 5016 },
            target: { width: 4096, height: 4096 },
            model: { id: "fixture-model", binaryVersion: "binary-v1", modelVersion: "model-v1" },
            canRetry: false,
            canCancel: true,
        });
        expect(publicImageEnhancement(fixture())).not.toHaveProperty("enhanced");
        expect(publicImageEnhancement(fixture())).not.toHaveProperty("ai");
    });
    it("never serializes credentials, frozen connection ownership, remote request identities or leases", () => {
        const job = fixture();
        Object.assign(job, { endpoint: "http://private-server", token: "private-token", arbitrary: "private-payload" });
        expect(JSON.stringify(publicImageEnhancement(job))).not.toContain("private-");
    });
    it("whitelists nested dimensions and published artifacts instead of forwarding future private fields", () => {
        const original = fixture();
        if (original.decision.status !== "queued") throw new Error("expected queued fixture");
        const artifact = { width: 4096, height: 4096, format: "png" as const, byteLength: 2000, sha256: "d".repeat(64), url: "/api/generation-log-assets/delivered.png", internal: "private-artifact" };
        const job = {
            ...original,
            decision: { ...original.decision, target: { ...original.decision.target, internal: "private-target" }, inference: { ...original.decision.inference, internal: "private-inference" } },
            publication: { ai: artifact, delivered: artifact, assetId: "asset-enhanced", publishedAt: 2000 },
        };
        const summary = publicImageEnhancement(job);
        expect(summary).toMatchObject({ target: { width: 4096, height: 4096 }, plannedInference: { width: 5016, height: 5016 }, enhanced: { url: artifact.url, width: 4096, height: 4096 } });
        expect(JSON.stringify(summary)).not.toContain("private-");
    });
    it("shows only permanently published variants and keeps receipt recovery successful", () => {
        const job = fixture();
        const artifact = { width: 5016, height: 5016, format: "png" as const, byteLength: 2000, sha256: "d".repeat(64), url: "/api/generation-log-assets/ai.png" };
        job.staged = { ai: artifact };
        expect(publicImageEnhancement(job)).not.toHaveProperty("ai");
        job.status = "succeeded";
        job.phase = "receipt";
        job.publication = { ai: artifact, delivered: { ...artifact, width: 4096, height: 4096, url: "/api/generation-log-assets/delivered.png", sha256: "e".repeat(64) }, assetId: "asset-enhanced", publishedAt: 2000 };
        expect(publicImageEnhancement(job)).toMatchObject({
            status: "succeeded",
            phase: "receipt",
            ai: { width: 5016, height: 5016 },
            enhanced: { width: 4096, height: 4096, url: "/api/generation-log-assets/delivered.png", assetId: "asset-enhanced" },
            canRetry: false,
            canCancel: false,
        });
    });
    it.each([
        ["failed", false, true, true],
        ["failed", true, false, true],
        ["queued", false, false, true],
        ["cancelled", true, false, false],
        ["skipped", false, false, false],
    ] as const)("publishes independent actions for %s with cancellation=%s", (status, cancelRequested, canRetry, canCancel) => {
        expect(publicImageEnhancement({ ...fixture(), status, cancelRequested })).toMatchObject({ canRetry, canCancel });
    });
});
