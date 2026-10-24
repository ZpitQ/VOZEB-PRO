import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, readlink } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function linuxIdentity(pid) {
    assert.equal(process.platform, "linux", "This private owned-process runner requires Linux /proc identity evidence");
    try {
        const raw = await readFile(`/proc/${pid}/stat`, "utf8");
        const fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
        return { pid, ppid: Number(fields[1]), pgrp: Number(fields[2]), session: Number(fields[3]), startTicks: fields[19], state: fields[0] };
    } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

const sameProcess = (a, b) => Boolean(a && b && a.pid === b.pid && a.startTicks === b.startTicks && a.pgrp === b.pgrp);
export async function untilObserved(read, accepts, label, timeout = 45_000) {
    const deadline = Date.now() + timeout;
    while (true) {
        const value = await read();
        if (accepts(value)) return value;
        if (Date.now() >= deadline) throw new Error(`Timed out observing ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

function childTerminal(child) {
    // Subscribe before readiness checks or signals; file descriptors avoid descendant pipe-close hangs.
    return new Promise((resolve) => {
        child.once("error", (error) => resolve({ error: error.message, observedAt: Date.now() }));
        child.once("exit", (code, signal) => resolve({ code, signal, observedAt: Date.now() }));
    });
}

async function ownsListener(pid, port) {
    const sockets = new Set();
    for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
        const rows = (await readFile(file, "utf8")).trim().split("\n").slice(1);
        for (const row of rows) {
            const fields = row.trim().split(/\s+/);
            if (fields[3] === "0A" && Number.parseInt(fields[1].split(":").at(-1), 16) === port) sockets.add(fields[9]);
        }
    }
    try {
        for (const name of await readdir(`/proc/${pid}/fd`)) {
            let target;
            try { target = await readlink(`/proc/${pid}/fd/${name}`); }
            catch (error) { if (error.code === "ENOENT") continue; throw error; }
            if (sockets.has(target.match(/^socket:\[(\d+)\]$/)?.[1])) return true;
        }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    return false;
}

export async function startOwnedWeb({ root, bootId, applicationEnv }) {
    assert.equal(process.platform, "linux");
    assert.equal(process.env.VOZEB_PRO_M5_RESTART_REENTRY, "1");
    assert.equal(path.resolve(root), path.resolve(process.env.VOZEB_PRO_M5_BUSINESS_DATA_DIR));
    assert.ok(path.basename(root).startsWith("vozeb-m5-business-"));
    assert.ok(!process.env.VOZEB_PRO_M5_BUSINESS_PRELOAD, "The Playwright owner must not load the application preload");
    const directory = path.join(root, ".m5-business-faults");
    await mkdir(directory, { recursive: true });
    const logPath = path.join(directory, `${bootId}-next.log`);
    const log = await open(logPath, "wx");
    const preload = pathToFileURL(path.resolve("e2e/image-enhancement-business-faults.fixture.mjs")).href;
    const child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", process.env.VOZEB_PRO_E2E_PORT], {
        cwd: process.cwd(), detached: true, stdio: ["ignore", log.fd, log.fd], env: {
            ...applicationEnv, VOZEB_PRO_DATA_DIR: root, VOZEB_PRO_DATABASE_PROVIDER: "file",
            VOZEB_PRO_M5_BUSINESS_PRELOAD: "1", VOZEB_PRO_M5_RESTART_BOOT_ID: bootId,
            NODE_OPTIONS: `${applicationEnv.NODE_OPTIONS || ""} --import=${preload}`.trim(),
        },
    });
    const terminal = childTerminal(child);
    const boot = { bootId, child, terminal, log, logPath, root, startedAt: Date.now(), cli: null, service: null, serviceRecord: null, stopped: null };
    try {
        boot.cli = await untilObserved(() => linuxIdentity(child.pid), Boolean, "owned Next CLI PID");
        assert.equal(boot.cli.pgrp, child.pid);
        assert.equal(boot.cli.session, child.pid);
        const baseURL = `http://127.0.0.1:${process.env.VOZEB_PRO_E2E_PORT}`;
        await untilObserved(async () => {
            if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Owned Next exited before readiness; inspect ${logPath}`);
            try { const reply = await fetch(`${baseURL}/api/auth/session`, { signal: AbortSignal.timeout(5_000) }); await reply.arrayBuffer(); return reply.ok; }
            catch { return false; }
        }, Boolean, "owned Next authentication Route readiness", 120_000);
        boot.serviceRecord = await untilObserved(async () => {
            for (const name of (await readdir(directory)).filter((entry) => /^preload-\d+\.json$/.test(entry))) {
                const record = JSON.parse(await readFile(path.join(directory, name), "utf8"));
                if (record.restartBootId !== bootId || record.runId !== process.env.VOZEB_PRO_M5_BUSINESS_RUN_ID || record.dataDir !== root) continue;
                const identity = await linuxIdentity(record.pid);
                if (!identity || identity.pgrp !== boot.cli.pgrp || identity.startTicks !== record.processStartTicks) continue;
                if (await ownsListener(record.pid, Number(process.env.VOZEB_PRO_E2E_PORT))) return { ...record, identity };
            }
            return null;
        }, Boolean, "the preloaded owned service process holding the selected listening socket");
        boot.service = boot.serviceRecord.identity;
        assert.notEqual(boot.service.pid, boot.cli.pid, "Record the actual Next service child separately from the CLI parent");
        assert.equal(boot.service.ppid, boot.cli.pid);
        return boot;
    } catch (error) {
        try { await stopOwnedWeb(boot); } catch (cleanup) { error.cleanupError = cleanup.message; }
        throw error;
    }
}

export function bootFacts(boot) {
    return { bootId: boot.bootId, cli: boot.cli, service: boot.service, root: boot.root, runId: process.env.VOZEB_PRO_M5_BUSINESS_RUN_ID, startedAt: boot.startedAt, readinessObservedAt: Date.now() };
}

export async function stopOwnedWeb(boot) {
    if (boot.stopped) return boot.stopped;
    const signalAt = Date.now();
    const currentCli = boot.cli && await linuxIdentity(boot.cli.pid);
    const currentService = boot.service && await linuxIdentity(boot.service.pid);
    let serviceFailure;
    if (currentService) {
        assert.ok(sameProcess(boot.service, currentService), "Refuse to signal a reused service PID");
        assert.equal(currentService.pgrp, boot.cli.pid);
        try {
            try { process.kill(currentService.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
            // Let the real CLI reap its child before any remaining owned CLI group is stopped.
            await untilObserved(() => linuxIdentity(currentService.pid), (identity) => identity === null, "old application PID disappearance");
        } catch (error) { serviceFailure = error; }
    }
    if (currentCli && sameProcess(boot.cli, await linuxIdentity(boot.cli.pid))) {
        assert.equal(currentCli.pgrp, boot.cli.pid);
        assert.equal(currentCli.session, boot.cli.pid);
        try { process.kill(-boot.cli.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    let timer;
    let terminal;
    try {
        terminal = await Promise.race([boot.terminal, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Owned Next CLI did not emit exit")), 45_000); })]);
        if (boot.cli) assert.equal(await linuxIdentity(boot.cli.pid), null);
        if (boot.service) assert.equal(await linuxIdentity(boot.service.pid), null);
        if (serviceFailure) throw serviceFailure;
    } finally { clearTimeout(timer); await boot.log.close(); }
    boot.stopped = { ...bootFacts(boot), signalAt, serviceGoneObservedAt: Date.now(), terminal, cliGone: true, serviceGone: true };
    return boot.stopped;
}

export async function proveOldOwnerFence({ root, old, next }) {
    const output = path.join(root, ".m5-business-faults", "old-owner-fence.json");
    const log = await open(path.join(root, ".m5-business-faults", "old-owner-fence.log"), "wx");
    const vitest = path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs");
    const child = spawn(process.execPath, [vitest, "run", "--config", ".codex-m5-restart-fence-v1.config.ts", "--no-file-parallelism", "--reporter=default"], {
        detached: true, stdio: ["ignore", log.fd, log.fd], env: { ...process.env, VOZEB_PRO_DATABASE_PROVIDER: "file", VOZEB_PRO_DATA_DIR: root,
            VOZEB_PRO_M5_RESTART_JOB_ID: old.id, VOZEB_PRO_M5_RESTART_USER_ID: old.userId,
            VOZEB_PRO_M5_RESTART_OLD_TOKEN: old.leaseToken, VOZEB_PRO_M5_RESTART_NEW_TOKEN: next.leaseToken,
            VOZEB_PRO_M5_RESTART_NEW_WORKER: next.workerId, VOZEB_PRO_M5_RESTART_FENCE_OUTPUT: output,
        },
    });
    const terminal = childTerminal(child);
    let timer;
    try {
        const result = await Promise.race([terminal, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Focused actual repository fence runtime timed out")), 45_000); })]);
        assert.equal(result.code, 0, "The focused actual repository guard assertion must pass; inspect its private log");
        assert.equal(result.signal, null);
        return { terminal: result, ...(JSON.parse(await readFile(output, "utf8"))) };
    } finally {
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) { process.kill(-child.pid, "SIGKILL"); await terminal; }
        await log.close();
    }
}

export async function restartSourceHashes() {
    const files = ["src/lib/server/image-enhancement-service.ts", "src/lib/server/database/image-enhancement-job-repository.ts", "src/lib/server/data-adapter.ts", "src/lib/server/image-enhancement-publication.ts", "src/lib/server/image-enhancement-worker-client.ts", "src/lib/server/image-enhancement-config.ts", "src/app/api/maintenance/generation-tasks/run/route.ts", "playwright.config.ts", "vitest.config.ts", "e2e/support.ts", "e2e/image-enhancement-business-faults.spec.ts", "e2e/image-enhancement-business-faults.fixture.mjs", "e2e/image-enhancement-restart.lifecycle.mjs", "e2e/image-enhancement-restart.executor.mjs", ".codex-m5-restart-v1.config.ts", ".codex-m5-restart-v1.runner.mjs", ".codex-m5-restart-fence-v1.config.ts", ".codex-m5-restart-fence-v1.test.ts"];
    return Promise.all(files.map(async (file) => ({ path: file, sha256: digest(await readFile(path.resolve(file))) })));
}

export function sanitizeRestartEvidence(value) {
    return JSON.parse(JSON.stringify(value, (key, entry) => {
        if (["endpoint", "upstreamEndpoint", "token", "leaseToken", "credentialRef", "oldToken", "newToken", "authorization", "proxy-authorization", "cookie", "set-cookie"].some((name) => name.toLowerCase() === key.toLowerCase())) return typeof entry === "string" ? { sha256: digest(entry) } : entry;
        return typeof entry === "string" ? entry.replace(/https?:\/\/[^\s\"'<>]+/g, "[owned-loopback-resource]").replace(/((?:proxy-)?authorization|(?:set-)?cookie)(\s*:\s*)[^\r\n]*/gi, "$1$2[redacted]") : entry;
    }));
}
