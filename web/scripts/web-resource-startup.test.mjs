import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, expect, it } from "vitest";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const marker = "WEB_RESOURCE_MAIN_STARTED";
const directories = [];
const children = new Set();
let source;
let environment;

beforeAll(async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "web-resource-startup-"));
    directories.push(directory);
    source = path.join(directory, "source");
    await mkdir(path.join(source, ".next/standalone"), { recursive: true });
    await mkdir(path.join(source, ".next/static"), { recursive: true });
    await mkdir(path.join(source, "public"));
    await cp(path.join(webRoot, "scripts"), path.join(source, "scripts"), { recursive: true });
    await cp(path.join(webRoot, ".image-processing-runtime"), path.join(source, ".image-processing-runtime"), { recursive: true });
    await symlink(path.join(webRoot, "node_modules"), path.join(source, "node_modules"), "junction");
    await writeFile(path.join(source, ".next/static/entry.js"), "export {};\n");
    await writeFile(path.join(source, "public/logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await writeFile(path.join(source, "public/icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await writeFile(
        path.join(source, ".next/standalone/server.js"),
        `const { createServer } = require("node:http");
const server = createServer((request, response) => response.end("ok"));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
server.listen(Number(process.env.PORT), "127.0.0.1", () => console.log("${marker}"));`,
    );
    await writeFile(path.join(source, "scripts/generation-worker.mjs"), 'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000);\n');
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    environment = {
        NODE_ENV: "test",
        NODE_OPTIONS: "--max-old-space-size=384",
        PORT: String(port),
        HOSTNAME: "127.0.0.1",
        VOZEB_PRO_INTERNAL_ORIGIN: origin,
        VOZEB_PRO_WORKER_API_ORIGIN: origin,
        VOZEB_PRO_DATA_DIR: path.join(source, ".data"),
        VOZEB_PRO_MAINTENANCE_TOKEN: "fixture-maintenance-token-distinct-at-least-32",
        VOZEB_PRO_WORKER_TOKEN: "fixture-worker-token-distinct-and-at-least-32",
        VOZEB_PRO_WEB_HEAP_MB: "384",
        VOZEB_PRO_GENERATION_WORKER_MEMORY_MB: "1536",
        VOZEB_PRO_GENERATION_WORKER_HEAP_MB: "64",
        VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB: "1024",
        VOZEB_PRO_IMAGE_PROCESS_HEAP_MB: "384",
        VOZEB_PRO_IMAGE_PROCESS_CONCURRENCY: "1",
    };
    const control = await runStartup(environment);
    expect(control, control.stderr).toMatchObject({ code: 0, signal: null });
    expect(control.stdout).toContain(marker);
}, 15_000);

afterAll(async () => {
    await Promise.all([...children].map(closeChild));
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
}, 15_000);

it.each([
    { label: "an image budget that leaves no supervisor headroom", override: { VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB: "1472" }, error: "Image processing budget plus supervisor heap" },
    { label: "a zero Web heap", override: { VOZEB_PRO_WEB_HEAP_MB: "0", NODE_OPTIONS: "--max-old-space-size=0" }, error: "VOZEB_PRO_WEB_HEAP_MB" },
])(
    "rejects $label before the Standalone Web main starts",
    async ({ override, error }) => {
        const result = await runStartup({ ...environment, ...override });
        expect(result, result.stderr).toMatchObject({ code: 1, signal: null });
        expect(result.stdout).not.toContain(marker);
        expect(result.stderr).toContain(error);
    },
    15_000,
);

function runStartup(env) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(source, "scripts/start-standalone.mjs")], { cwd: source, env, stdio: ["ignore", "pipe", "pipe"] });
        children.add(child);
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
            if (stdout.includes(marker)) child.kill("SIGTERM");
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });
        child.once("error", reject);
        child.once("close", (code, signal) => {
            children.delete(child);
            resolve({ code, signal, stdout, stderr });
        });
    });
}

async function freePort() {
    const server = createServer();
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    return port;
}

function closeChild(child) {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
        child.once("close", resolve);
        child.kill("SIGTERM");
    });
}
