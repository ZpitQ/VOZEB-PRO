import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageEnhancementJob } from "@/lib/server/database/image-enhancement-job-repository";
import { planImageEnhancement } from "@/lib/server/image-enhancement-plan";
import { publicImageEnhancement } from "@/lib/server/image-enhancement-public";

const mocks = vi.hoisted(() => ({ currentUser: vi.fn(), getJob: vi.fn(), retry: vi.fn(), cancel: vi.fn(), runBatch: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.currentUser }));
vi.mock("@/lib/server/database/image-enhancement-job-repository", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/server/database/image-enhancement-job-repository")>()),
    getEnhancementJob: mocks.getJob,
}));
vi.mock("@/lib/server/image-enhancement-service", () => ({ retryImageEnhancement: mocks.retry, cancelImageEnhancement: mocks.cancel, runImageEnhancementBatch: mocks.runBatch }));

import { GET, POST } from "./route";

const context = { params: Promise.resolve({ id: "enhancement:fixture:1" }) };
function request(action?: unknown, raw?: string) {
    return new Request(
        "http://localhost/api/image-enhancements/enhancement%3Afixture%3A1",
        action === undefined && raw === undefined
            ? undefined
            : {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: raw ?? JSON.stringify({ action, userId: "private-forged-owner" }),
              },
    );
}
function fixture(): ImageEnhancementJob {
    return {
        id: "enhancement:fixture:1",
        userId: "fixture-owner",
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
        status: "failed",
        phase: "poll",
        reason: "connection_failed",
        attempt: 1,
        remoteKey: "private-remote-key",
        remoteJobId: "private-remote-job",
        receiptId: "private-receipt",
        events: [{ stage: "failed", at: 2000, attempt: 1, reason: "connection_failed" }],
        cancelRequested: false,
        createdAt: 1000,
        updatedAt: 2000,
        nextPollAt: null,
        workerId: "private-worker",
        leaseToken: "private-lease",
        leaseUntil: 90000,
    };
}

describe("/api/image-enhancements/[id] public task boundary", () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mocks.currentUser.mockResolvedValue({ id: "fixture-owner", role: "user" });
        mocks.getJob.mockResolvedValue(fixture());
        mocks.retry.mockResolvedValue({ ...fixture(), status: "queued", reason: null });
        mocks.cancel.mockResolvedValue({ ...fixture(), status: "queued", cancelRequested: true });
    });

    it.each([GET, POST])("requires a session before reading or changing an enhancement", async (handler) => {
        mocks.currentUser.mockResolvedValue(null);
        const response = await handler(request("retry"), context);
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ code: 401, data: null, msg: "请先登录" });
        expect(mocks.getJob).not.toHaveBeenCalled();
        expect(mocks.retry).not.toHaveBeenCalled();
        expect(mocks.cancel).not.toHaveBeenCalled();
    });

    it.each([GET, POST])("uses the same owner-scoped 404 for missing and another user's task", async (handler) => {
        mocks.currentUser.mockResolvedValue({ id: "other-owner", role: "user" });
        mocks.getJob.mockResolvedValue(null);
        const missing = await handler(request("retry"), context);
        mocks.getJob.mockResolvedValue(fixture());
        const forbidden = await handler(request("retry"), context);
        expect(missing.status).toBe(404);
        expect(forbidden.status).toBe(404);
        expect(await forbidden.json()).toEqual(await missing.json());
        expect(mocks.getJob).toHaveBeenNthCalledWith(1, "enhancement:fixture:1", "other-owner");
        expect(mocks.getJob).toHaveBeenNthCalledWith(2, "enhancement:fixture:1", "other-owner");
        expect(mocks.retry).not.toHaveBeenCalled();
        expect(mocks.cancel).not.toHaveBeenCalled();
    });

    it("returns only the public summary without queue, GPU, retry or cancellation work", async () => {
        const job = Object.assign(fixture(), { token: "private-token", unknownFuture: "private-future" });
        mocks.getJob.mockResolvedValue(job);
        const response = await GET(request(), context);
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        const body = await response.json();
        expect(body).toEqual({ code: 0, data: publicImageEnhancement(job), msg: "OK" });
        expect(body.data).toMatchObject({ id: job.id, resultId: job.resultId, native: { width: 1254, height: 1254 }, canRetry: true });
        expect(JSON.stringify(body)).not.toContain("private-");
        expect(mocks.getJob).toHaveBeenCalledExactlyOnceWith(job.id, job.userId);
        expect(mocks.retry).not.toHaveBeenCalled();
        expect(mocks.cancel).not.toHaveBeenCalled();
        expect(mocks.runBatch).not.toHaveBeenCalled();
    });

    it("allows a verified administrator to read only the requested enhancement id", async () => {
        mocks.currentUser.mockResolvedValue({ id: "administrator", role: "admin" });
        const response = await GET(request(), context);
        expect(response.status).toBe(200);
        expect(mocks.getJob).toHaveBeenCalledExactlyOnceWith("enhancement:fixture:1", undefined);
        expect(JSON.stringify(await response.json())).not.toContain("private-");
    });

    it.each(["retry", "cancel"] as const)("%s uses the persisted owner and returns the changed public summary", async (action) => {
        const response = await POST(request(action), context);
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toEqual({ code: 0, data: publicImageEnhancement(await (action === "retry" ? mocks.retry : mocks.cancel).mock.results[0].value), msg: "OK" });
        expect(action === "retry" ? mocks.retry : mocks.cancel).toHaveBeenCalledExactlyOnceWith("enhancement:fixture:1", "fixture-owner");
        expect(action === "retry" ? mocks.cancel : mocks.retry).not.toHaveBeenCalled();
        expect(mocks.runBatch).not.toHaveBeenCalled();
        expect(JSON.stringify(body)).not.toContain("private-");
    });

    it.each(["retry", "cancel"] as const)("administrator %s preserves the original owner", async (action) => {
        mocks.currentUser.mockResolvedValue({ id: "administrator", role: "admin" });
        const response = await POST(request(action), context);
        expect(response.status).toBe(200);
        expect(mocks.getJob).toHaveBeenCalledExactlyOnceWith("enhancement:fixture:1", undefined);
        expect(action === "retry" ? mocks.retry : mocks.cancel).toHaveBeenCalledExactlyOnceWith("enhancement:fixture:1", "fixture-owner");
    });

    it.each(["recover", "submit", "", 1, null])("rejects unsupported action %s", async (action) => {
        const response = await POST(request(action), context);
        expect(response.status).toBe(400);
        expect((await response.json()).data).toBeNull();
        expect(mocks.retry).not.toHaveBeenCalled();
        expect(mocks.cancel).not.toHaveBeenCalled();
    });

    it.each(["{broken", "null", "[]", "{}"])("rejects invalid JSON or missing action without an effect: %s", async (raw) => {
        const response = await POST(request(undefined, raw), context);
        expect(response.status).toBe(400);
        expect((await response.json()).code).toBe(400);
        expect(mocks.retry).not.toHaveBeenCalled();
        expect(mocks.cancel).not.toHaveBeenCalled();
    });

    it.each(["retry", "cancel"] as const)("returns conflict when the service rejects %s", async (action) => {
        (action === "retry" ? mocks.retry : mocks.cancel).mockResolvedValue(null);
        const response = await POST(request(action), context);
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: 409, data: null });
        expect(mocks.runBatch).not.toHaveBeenCalled();
    });

    it.each([GET, POST])("redacts repository errors with one fixed Chinese response", async (handler) => {
        mocks.getJob.mockRejectedValue(new Error("private-token http://private-worker private-database"));
        const response = await handler(request("retry"), context);
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ code: 500, data: null, msg: "增强任务操作失败，请稍后重试" });
    });

    it.each(["retry", "cancel"] as const)("redacts unexpected %s service and Worker failures", async (action) => {
        (action === "retry" ? mocks.retry : mocks.cancel).mockRejectedValue(new Error("private-worker-token"));
        const response = await POST(request(action), context);
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ code: 500, data: null, msg: "增强任务操作失败，请稍后重试" });
    });
});
