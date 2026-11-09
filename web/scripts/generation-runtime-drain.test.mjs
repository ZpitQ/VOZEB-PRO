import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const directories = [];
const children = [];
const releases = [];
afterEach(async () => {
    await Promise.all(releases.splice(0).map((release) => release()));
    await Promise.all(children.splice(0).map((child) => closeChild(child)));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
}, 15_000);

describe("generation runtime process drain", () => {
    it("keeps Web available until the worker's active HTTP work drains", async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "generation-runtime-drain-"));
        directories.push(directory);
        const port = await freePort();
        const origin = `http://127.0.0.1:${port}`;
        releases.push(async () => {
            await fetch(origin + "/release")
                .then((response) => response.text())
                .catch(() => {});
        });
        const app = path.join(directory, "app.mjs");
        const worker = path.join(directory, "worker.mjs");
        const harness = path.join(directory, "harness.mjs");
        await writeFile(
            app,
            `import { createServer } from "node:http"; let pending; const server = createServer((request, response) => { if (request.url === "/drain") { pending = response; console.log("WORK_ACTIVE"); } else if (request.url === "/release") { pending.end("finished"); response.end("released"); } else response.end("ok"); }); server.listen(${port}, "127.0.0.1"); process.on("SIGTERM", () => { console.log("WEB_STOPPING"); server.close(() => process.exit(0)); });`,
        );
        await writeFile(worker, `process.on("SIGTERM", () => console.log("WORKER_DRAINING")); await fetch(${JSON.stringify(origin + "/drain")}).then((response) => response.text()); console.log("WORKER_FINISHED");`);
        const runtime = new URL("./generation-runtime.mjs", import.meta.url).href;
        await writeFile(
            harness,
            `import { superviseGenerationRuntime } from ${JSON.stringify(runtime)}; process.exitCode = await superviseGenerationRuntime({ app: { command: process.execPath, args: [${JSON.stringify(app)}], cwd: ${JSON.stringify(directory)} }, workerScript: ${JSON.stringify(worker)}, environment: { ...process.env, VOZEB_PRO_WORKER_API_ORIGIN: ${JSON.stringify(origin)} } });`,
        );
        const child = spawn(process.execPath, [harness], { cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
        children.push(child);
        const observed = observe(child);
        await observed.line("WORK_ACTIVE");
        child.kill("SIGTERM");
        await observed.line("WORKER_DRAINING");
        expect(observed.output()).not.toContain("WEB_STOPPING");
        expect((await fetch(origin + "/api/health/live")).status).toBe(200);
        await fetch(origin + "/release");
        const closed = await observed.closed;
        expect(closed.code, closed.stderr).toBe(0);
        expect(observed.output()).toContain("WORKER_FINISHED");
        expect(observed.output()).toContain("WEB_STOPPING");
        expect(observed.output().indexOf("WORKER_FINISHED")).toBeLessThan(observed.output().indexOf("WEB_STOPPING"));
    }, 15_000);
});

function observe(child) {
    let output = "";
    let stderr = "";
    const waiters = new Map();
    child.stdout.on("data", (chunk) => {
        output += chunk;
        for (const [marker, resolve] of waiters)
            if (output.includes(marker)) {
                waiters.delete(marker);
                resolve();
            }
    });
    child.stderr.on("data", (chunk) => {
        stderr += chunk;
    });
    const closed = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => {
            for (const resolve of waiters.values()) resolve();
            resolve({ code, signal, stderr });
        });
    });
    return { output: () => output, line: (marker) => (output.includes(marker) ? Promise.resolve() : new Promise((resolve) => waiters.set(marker, resolve))), closed };
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
