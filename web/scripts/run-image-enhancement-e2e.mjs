// From web/: node scripts/run-image-enhancement-e2e.mjs
// Synthetic source and controlled LLM/image/Worker protocol evidence; not GPU quality or F01/F02 acceptance.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

async function freePort() {
    const server = createServer().listen(0, "127.0.0.1");
    await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    return String(address.port);
}

const data = await mkdtemp(join(tmpdir(), "vozeb-m5-business-"));
const runId = randomUUID();
const source = join(data, "native-source.png");
const storageState = join(data, "admin-state.json");
const output = join(process.cwd(), ".e2e-artifacts", `image-enhancement-${runId}`);
await writeFile(source, await sharp({ create: { width: 1254, height: 1254, channels: 3, background: "#4a778b" } }).png().toBuffer(), { flag: "wx" });
const native = await readFile(source);
const image = sharp(native, { failOn: "warning" });
const metadata = await image.metadata();
assert.equal(metadata.width, 1254);
assert.equal(metadata.height, 1254);
assert.equal(metadata.format, "png");
assert.equal((await image.stats()).isOpaque, true);
const sourceSha256 = createHash("sha256").update(native).digest("hex");
const ports = await Promise.all([freePort(), freePort(), freePort()]);
assert.equal(new Set(ports).size, 3, "Loopback port allocation collided");
console.log(JSON.stringify({ data, runId, source, storageState, output, ports, sourceSha256, kind: "synthetic source and controlled LLM/image/Worker protocol evidence; not GPU quality or F01/F02 acceptance" }));

const child = spawn(process.execPath, [fileURLToPath(import.meta.resolve("@playwright/test/cli")), "test", "--config", "playwright.image-enhancement.config.ts", "--project=chromium", "--workers=1", "--retries=0"], {
    stdio: "inherit",
    env: {
        ...process.env,
        NODE_OPTIONS: "",
        DATABASE_URL: "",
        VOZEB_PRO_E2E_DATABASE_URL: "",
        VOZEB_PRO_M5_BUSINESS_PRELOAD: "",
        VOZEB_PRO_M5_RESTART_REENTRY: "",
        VOZEB_PRO_M5_RESTART_BOOT_ID: "",
        VOZEB_PRO_E2E_PORT: ports[0],
        VOZEB_PRO_PROTOCOL_FIXTURE_PORT: ports[1],
        VOZEB_PRO_PAYMENT_FIXTURE_PORT: ports[2],
        VOZEB_PRO_M5_BROWSER_DATA: data,
        VOZEB_PRO_M5_BROWSER_STATE: storageState,
        VOZEB_PRO_M5_BROWSER_OUTPUT: output,
        VOZEB_PRO_M5_BUSINESS_FAULTS: "1",
        VOZEB_PRO_M5_F13_BUSINESS: "1",
        VOZEB_PRO_M5_BUSINESS_RUN_ID: runId,
        VOZEB_PRO_M5_BUSINESS_DATA_DIR: data,
        VOZEB_PRO_M5_BUSINESS_NATIVE_SOURCE: source,
        VOZEB_PRO_M5_BUSINESS_NATIVE_SHA256: sourceSha256,
    },
});
child.on("error", (error) => { console.error(error); process.exitCode = 1; });
child.on("exit", (code, signal) => {
    if (signal) console.error(`Playwright terminated by ${signal}`);
    process.exitCode = code ?? 1;
});
