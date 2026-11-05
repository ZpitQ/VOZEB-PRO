import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

const directories = [];
const children = [];

afterEach(async () => {
    await Promise.all(children.splice(0).map(closeChild));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
}, 15_000);

it("starts the Worker with only its transport and resource settings and its own heap limit", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "generation-worker-environment-"));
    directories.push(directory);
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const app = path.join(directory, "app.mjs");
    const worker = path.join(directory, "worker.mjs");
    const harness = path.join(directory, "harness.mjs");
    const allowed = {
        NODE_ENV: "test",
        LANG: "C.UTF-8",
        TZ: "UTC",
        VOZEB_PRO_WORKER_API_ORIGIN: origin,
        VOZEB_PRO_WORKER_TOKEN: "fixture-worker-token-distinct-and-at-least-32",
        VOZEB_PRO_GENERATION_WORKER_ID: "fixture-isolated-worker",
        VOZEB_PRO_GENERATION_WORKER_INTERVAL_MS: "500",
        VOZEB_PRO_GENERATION_WORKER_LANES: "2",
        VOZEB_PRO_GENERATION_WORKER_HEARTBEAT_MS: "5000",
        VOZEB_PRO_GENERATION_WORKER_MEMORY_MB: "1536",
        VOZEB_PRO_GENERATION_WORKER_HEAP_MB: "64",
        VOZEB_PRO_GENERATION_WORKER_CPUS: "0.5",
        VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB: "1024",
        VOZEB_PRO_IMAGE_PROCESS_HEAP_MB: "384",
        VOZEB_PRO_IMAGE_PROCESS_CONCURRENCY: "1",
    };
    const environment = {
        ...allowed,
        NODE_OPTIONS: "--max-old-space-size=512",
        VOZEB_PRO_MAINTENANCE_TOKEN: "fixture-maintenance-token-distinct-at-least-32",
        DATABASE_URL: "fixture-database-credential",
        POSTGRES_URL: "fixture-postgres-credential",
        OPENAI_API_KEY: "fixture-model-credential",
        AWS_SECRET_ACCESS_KEY: "fixture-object-storage-credential",
        VOZEB_PRO_UNRELATED_SECRET: "fixture-unlisted-credential",
    };
    await writeFile(
        app,
        `import { createServer } from "node:http";
import { getHeapStatistics } from "node:v8";
console.log("WEB_ENV:" + JSON.stringify({ environment: process.env, heapLimit: getHeapStatistics().heap_size_limit }));
const server = createServer((request, response) => response.end("ok"));
server.listen(${port}, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));`,
    );
    await writeFile(
        worker,
        `import { getHeapStatistics } from "node:v8";
const response = await fetch(process.env.VOZEB_PRO_WORKER_API_ORIGIN + "/api/health/live");
if (!response.ok) throw new Error("Worker transport is unavailable");
process.on("SIGTERM", () => process.exit(0));
console.log("WORKER_ENV:" + JSON.stringify({ environment: process.env, heapLimit: getHeapStatistics().heap_size_limit }));
await new Promise(() => setInterval(() => {}, 1000));`,
    );
    const runtime = new URL("./generation-runtime.mjs", import.meta.url).href;
    await writeFile(
        harness,
        `import { superviseGenerationRuntime } from ${JSON.stringify(runtime)};
process.exitCode = await superviseGenerationRuntime({ app: { command: process.execPath, args: [${JSON.stringify(app)}], cwd: ${JSON.stringify(directory)} }, workerScript: ${JSON.stringify(worker)}, environment: ${JSON.stringify(environment)} });`,
    );
    const child = spawn(process.execPath, [harness], { cwd: directory, env: environment, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    const observed = observe(child);
    const webEnvironment = await observed.record("WEB_ENV:");
    const workerEnvironment = await observed.record("WORKER_ENV:");

    try {
        expect(webEnvironment.environment).toStrictEqual(environment);
        expect(workerEnvironment.environment).toStrictEqual(allowed);
        expect(webEnvironment.heapLimit).toBeGreaterThanOrEqual(512 * 1024 * 1024);
        expect(webEnvironment.heapLimit).toBeLessThanOrEqual(640 * 1024 * 1024);
        expect(workerEnvironment.heapLimit).toBeGreaterThanOrEqual(64 * 1024 * 1024);
        expect(workerEnvironment.heapLimit).toBeLessThanOrEqual(128 * 1024 * 1024);
    } finally {
        child.kill("SIGTERM");
        expect(await observed.closed).toStrictEqual({ code: 0, signal: null, stderr: "" });
    }
}, 15_000);

function observe(child) {
    let output = "";
    let stderr = "";
    const records = new Map();
    const waiters = new Map();
    child.stdout.on("data", (chunk) => {
        output += chunk;
        for (const line of output.split("\n").slice(0, -1)) {
            const separator = line.indexOf(":");
            const marker = line.slice(0, separator + 1);
            if (marker !== "WEB_ENV:" && marker !== "WORKER_ENV:") continue;
            const record = JSON.parse(line.slice(separator + 1));
            records.set(marker, record);
            waiters.get(marker)?.resolve(record);
            waiters.delete(marker);
        }
    });
    child.stderr.on("data", (chunk) => {
        stderr += chunk;
    });
    const closed = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => {
            for (const waiter of waiters.values()) waiter.reject(new Error("Runtime closed before reporting its environment: " + stderr));
            resolve({ code, signal, stderr });
        });
    });
    return {
        record: (marker) => (records.has(marker) ? Promise.resolve(records.get(marker)) : new Promise((resolve, reject) => waiters.set(marker, { resolve, reject }))),
        closed,
    };
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
        child.kill("SIGINT");
    });
}
