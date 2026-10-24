import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    configured: vi.fn(),
    authorized: vi.fn(),
    recover: vi.fn(),
    nextDueAt: vi.fn(),
    install: vi.fn(),
    enhance: vi.fn(),
    enhancementDueAt: vi.fn(),
}));

vi.mock("@/lib/server/maintenance-auth", () => ({
    isWorkerTokenConfigured: mocks.configured,
    isAuthorizedWorkerRequest: mocks.authorized,
}));
vi.mock("@/lib/server/generation-task-recovery-service", () => ({ runGenerationTaskRecoveryBatch: mocks.recover }));
vi.mock("@/lib/server/generation-task-scheduler", () => ({ getNextGenerationTaskDueAt: mocks.nextDueAt }));
vi.mock("@/lib/server/internal-origin", () => ({ resolveInternalOrigin: vi.fn(() => "http://internal:3000") }));
vi.mock("@/lib/server/install-status", () => ({ getInstallStatus: mocks.install }));
vi.mock("@/lib/server/image-enhancement-service", () => ({ runImageEnhancementBatch: mocks.enhance }));
vi.mock("@/lib/server/database/image-enhancement-job-repository", () => ({ nextEnhancementDueAt: mocks.enhancementDueAt }));

import { maxDuration, POST } from "./route";

describe("POST /api/maintenance/generation-tasks/run", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://vozeb.example");
        mocks.configured.mockReturnValue(true);
        mocks.authorized.mockReturnValue(true);
        mocks.recover.mockResolvedValue({ claimed: 0 });
        mocks.nextDueAt.mockResolvedValue(undefined);
        mocks.install.mockResolvedValue({ database: { schemaReady: true } });
        mocks.enhance.mockResolvedValue({ claimed: 0, completed: 0, failed: 0 });
        mocks.enhancementDueAt.mockResolvedValue(null);
    });

    it("allows a worker batch to outlive the longest upstream model request", () => {
        expect(maxDuration).toBeGreaterThanOrEqual(40 * 60);
    });

    it("refuses to run without a configured worker token", async () => {
        mocks.configured.mockReturnValue(false);
        const response = await POST(request());
        expect(response.status).toBe(503);
        expect(mocks.recover).not.toHaveBeenCalled();
        expect(mocks.enhance).not.toHaveBeenCalled();
    });

    it("requires worker authentication", async () => {
        mocks.authorized.mockReturnValue(false);
        const response = await POST(request());
        expect(response.status).toBe(401);
        expect(mocks.recover).not.toHaveBeenCalled();
        expect(mocks.enhance).not.toHaveBeenCalled();
    });

    it("passes the stable worker identity and server-only origins to the recovery batch", async () => {
        mocks.recover.mockResolvedValue({ claimed: 2 });
        mocks.nextDueAt.mockResolvedValue(5_000);
        const response = await POST(request("worker-one"));

        expect(response.status).toBe(200);
        expect(mocks.recover).toHaveBeenCalledWith({ origin: "http://internal:3000", publicOrigin: "https://vozeb.example", limit: 50, workerId: "worker-one" });
        expect(await response.json()).toMatchObject({ code: 0, data: { claimed: 2, nextDueAt: 5_000 } });
    });

    it("waits quietly before the database is initialized", async () => {
        mocks.install.mockResolvedValue({ database: { schemaReady: false } });

        const response = await POST(request("worker-one"));

        expect(response.status).toBe(200);
        expect(mocks.recover).not.toHaveBeenCalled();
        expect(mocks.enhance).not.toHaveBeenCalled();
        await expect(response.json()).resolves.toMatchObject({ code: 0, data: { claimed: 0 } });
    });

    it("processes due enhancement jobs with no native generation work and exposes their next wake time", async () => {
        mocks.enhance.mockResolvedValue({ claimed: 1, completed: 0, failed: 0 });
        mocks.enhancementDueAt.mockResolvedValue(4_000);
        mocks.nextDueAt.mockResolvedValue(8_000);
        const response = await POST(request("worker-one"));
        expect(mocks.enhance).toHaveBeenCalledWith({ origin: "http://internal:3000", limit: 50, workerId: "worker-one" });
        expect(await response.json()).toMatchObject({ code: 0, data: { claimed: 0, enhancement: { claimed: 1 }, nextDueAt: 4_000 } });
    });

    it("keeps native recovery results when only the independent enhancement batch fails", async () => {
        mocks.recover.mockResolvedValue({ claimed: 2, completed: 2 });
        mocks.enhance.mockRejectedValueOnce(new Error("private infrastructure failure"));
        const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
        try {
            const response = await POST(request());
            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({ code: 0, data: { claimed: 2, completed: 2, enhancement: { unavailable: true } } });
            expect(JSON.stringify(log.mock.calls)).not.toContain("private infrastructure failure");
        } finally {
            log.mockRestore();
        }
    });
});

function request(workerId = "") {
    return new Request("http://localhost/api/maintenance/generation-tasks/run", {
        method: "POST",
        headers: {
            authorization: "Bearer test-token",
            ...(workerId ? { "x-vozeb-pro-worker-id": workerId } : {}),
        },
    });
}
