import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "@playwright/test";

import base from "./playwright.config";

// Root launches this from its owned bench and owns the separate service scopes.
export default defineConfig({
    ...base,
    testDir: fileURLToPath(new URL("./e2e", import.meta.url)),
    outputDir: path.join(process.cwd(), ".e2e-artifacts"),
    reporter: [["list"], ["json", { outputFile: path.join(process.cwd(), "resident-f02-playwright.json") }]],
    webServer: [],
    workers: 1,
    retries: 0,
});
