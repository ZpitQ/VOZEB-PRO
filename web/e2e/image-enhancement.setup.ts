import { expect, test } from "@playwright/test";

import { E2E_ADMIN, e2eSettingsPatch } from "./support";

test("initialize the isolated image enhancement fixture", async ({ request }) => {
    const status = await request.get("/api/install/status");
    expect(status.ok()).toBe(true);
    const installation = (await status.json()).install;
    if (installation.database?.schemaReady === false) {
        const initialized = await request.post("/api/install/initialize", { data: { installToken: E2E_ADMIN.installToken } });
        expect(initialized.ok()).toBe(true);
    }
    const registered = await request.post("/api/auth/register", { data: { username: E2E_ADMIN.username, displayName: E2E_ADMIN.displayName, password: E2E_ADMIN.password, installToken: E2E_ADMIN.installToken } });
    expect(registered.ok()).toBe(true);
    const settings = await request.patch("/api/admin/settings", { data: e2eSettingsPatch() });
    expect(settings.ok()).toBe(true);
    await request.storageState({ path: process.env.VOZEB_PRO_M5_BROWSER_STATE! });
});
