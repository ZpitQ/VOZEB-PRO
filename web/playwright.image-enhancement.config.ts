import path from "node:path";
import { pathToFileURL } from "node:url";

import { defineConfig, devices } from "@playwright/test";

import base from "./playwright.config";

const data = process.env.VOZEB_PRO_M5_BROWSER_DATA;
const storageState = process.env.VOZEB_PRO_M5_BROWSER_STATE;
const outputDir = process.env.VOZEB_PRO_M5_BROWSER_OUTPUT;
if (!data || !storageState || !outputDir) throw new Error("Run node scripts/run-image-enhancement-e2e.mjs from web/.");
if (process.env.VOZEB_PRO_M5_BUSINESS_PRELOAD || process.env.VOZEB_PRO_E2E_DATABASE_URL || process.env.DATABASE_URL) throw new Error("image_enhancement_e2e_requires_isolated_environment");

const preload = pathToFileURL(path.resolve("e2e/image-enhancement-business-faults.fixture.mjs")).href;
const servers = base.webServer as Array<{ command: string; env: Record<string, string> }>;

export default defineConfig({
    ...base,
    timeout: 600_000,
    expect: { timeout: 45_000 },
    workers: 1,
    retries: 0,
    reporter: "list",
    outputDir,
    use: { ...base.use, actionTimeout: 45_000, trace: "off", video: "off" },
    projects: [
        { name: "setup", testMatch: /image-enhancement\.setup\.ts/ },
        {
            name: "chromium",
            testMatch: /image-enhancement-generation\.spec\.ts/,
            grep: /SR-M5-07\/F13 actual frozen scene chain:/,
            dependencies: ["setup"],
            use: { ...devices["Desktop Chrome"], storageState },
        },
    ],
    webServer: servers.map((server, index) => ({
        ...server,
        reuseExistingServer: false,
        ...(index === servers.length - 1
            ? {
                  command: `pnpm exec next dev --hostname 127.0.0.1 --port ${process.env.VOZEB_PRO_E2E_PORT}`,
                  env: {
                      ...server.env,
                      VOZEB_PRO_DATA_DIR: data,
                      VOZEB_PRO_DATABASE_PROVIDER: "file",
                      DATABASE_URL: "",
                      VOZEB_PRO_M5_BUSINESS_PRELOAD: "1",
                      NODE_OPTIONS: `--import=${preload}`,
                  },
              }
            : {}),
    })),
});
