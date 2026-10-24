import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), read: vi.fn(), save: vi.fn(), check: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/server/audit-log-store", () => ({ auditActorFromRequest: vi.fn(() => ({ userId: "fixture-admin" })), safeRecordAuditLog: mocks.audit }));
vi.mock("@/lib/server/image-enhancement-config", async (original) => ({
    ...(await original<typeof import("@/lib/server/image-enhancement-config")>()),
    getImageEnhancementSettings: mocks.read,
    saveImageEnhancementSettings: mocks.save,
    checkImageEnhancementSettings: mocks.check,
}));

import { GET, PATCH, POST } from "./route";
import { ImageEnhancementConfigError } from "@/lib/server/image-enhancement-config";

const handlers = { GET, PATCH, POST };
function request(method: keyof typeof handlers, body: unknown = method === "POST" ? { revision: "fixture-revision", action: "sample" } : { revision: "fixture-revision" }) {
    return new Request("http://localhost/api/admin/image-enhancement", { method, ...(method === "GET" ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
}
beforeEach(() => {
    vi.clearAllMocks();
    mocks.user.mockResolvedValue({ id: "fixture-admin", role: "admin", status: "active", adminPermissions: ["system.manage"] });
    mocks.read.mockResolvedValue({ revision: "fixture-revision", enabled: false, ready: false, hasToken: true });
    mocks.save.mockImplementation(mocks.read);
    mocks.check.mockImplementation(mocks.read);
});

describe("image enhancement administration boundary", () => {
    it.each(["GET", "PATCH", "POST"] as const)("allows authorized %s without a second password", async (method) => {
        const response = await handlers[method](request(method));
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toContain("no-store");
        expect((await response.json()).code).toBe(0);
    });
    for (const identity of [null, { role: "user", status: "active" }, { role: "admin", status: "active", adminPermissions: ["generation.read"] }]) {
        it.each(["GET", "PATCH", "POST"] as const)(`rejects unauthorized %s for ${identity?.role ?? "anonymous"}`, async (method) => {
            mocks.user.mockResolvedValue(identity);
            const response = await handlers[method](request(method, { revision: "fixture-revision", clearToken: true, enabled: true, action: "sample" }));
            expect(response.status).toBe(identity ? 403 : 401);
            expect(mocks.read).not.toHaveBeenCalled();
            expect(mocks.save).not.toHaveBeenCalled();
            expect(mocks.check).not.toHaveBeenCalled();
        });
    }
    it("never echoes arbitrary upstream or storage exception text", async () => {
        const secret = "fixture-private-access-key";
        mocks.check.mockRejectedValue(new Error(secret));
        const response = await POST(request("POST"));
        expect(response.status).toBe(500);
        expect(await response.text()).not.toContain(secret);
        expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(secret);
    });
    it("maps stale revisions to conflict", async () => {
        mocks.save.mockRejectedValue(new ImageEnhancementConfigError("configuration_changed", 409));
        expect((await PATCH(request("PATCH"))).status).toBe(409);
    });
    it("rejects malformed JSON before checking or saving", async () => {
        const response = await POST(new Request("http://localhost/api/admin/image-enhancement", { method: "POST", body: "{" }));
        expect(response.status).toBe(400);
        expect(mocks.check).not.toHaveBeenCalled();
    });
    it("audits changes using non-secret metadata", async () => {
        await PATCH(request("PATCH", { revision: "fixture-revision", token: "fixture-private-access-key" }));
        expect(mocks.audit).toHaveBeenCalledOnce();
        expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("fixture-private-access-key");
    });
});
