import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getCurrentUser: vi.fn(), getPublicUsersByIds: vi.fn(), hasAdminPermission: vi.fn(), listGenerationLogs: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/auth/store", () => ({ getPublicUsersByIds: mocks.getPublicUsersByIds }));
vi.mock("@/lib/admin-permissions", () => ({ hasAdminPermission: mocks.hasAdminPermission }));
vi.mock("@/lib/server/generation-log-store", () => ({ listGenerationLogs: mocks.listGenerationLogs, deleteGenerationLogs: vi.fn() }));

import { GET, dynamic } from "./route";

describe("administrator generation log GET", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCurrentUser.mockResolvedValue({ id: "admin-one", role: "admin" });
        mocks.hasAdminPermission.mockReturnValue(true);
        mocks.listGenerationLogs.mockResolvedValue({ items: [{ id: "log-one", userId: "owner-one", assets: [] }], total: 1, page: 1, pageSize: 20 });
        mocks.getPublicUsersByIds.mockResolvedValue([{ id: "owner-one", accountId: "0001" }]);
    });

    it("requests current enhancement observations only for the authorized paginated administrator read and disables response caching", async () => {
        const response = await GET(new NextRequest("http://localhost/api/admin/generation-logs?page=1&pageSize=20"));
        expect(mocks.hasAdminPermission).toHaveBeenCalledWith(expect.anything(), "generation.read");
        expect(mocks.listGenerationLogs).toHaveBeenCalledWith(expect.objectContaining({ page: 1, pageSize: 20, includeEcommerceTrace: true, includeImageEnhancement: true }));
        expect(dynamic).toBe("force-dynamic");
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(await response.json()).toMatchObject({ logs: [{ id: "log-one", accountId: "0001" }], total: 1 });
    });

    it.each([false, true])("does not read jobs or logs without a valid administrator read permission (signedIn=%s)", async (signedIn) => {
        mocks.getCurrentUser.mockResolvedValue(signedIn ? { id: "admin-one", role: "admin" } : null);
        mocks.hasAdminPermission.mockReturnValue(false);
        const response = await GET(new NextRequest("http://localhost/api/admin/generation-logs"));
        expect(response.status).toBe(signedIn ? 403 : 401);
        expect(mocks.listGenerationLogs).not.toHaveBeenCalled();
        expect(mocks.getPublicUsersByIds).not.toHaveBeenCalled();
    });
});
