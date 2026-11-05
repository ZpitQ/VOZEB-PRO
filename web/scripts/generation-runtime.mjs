import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const MIN_TOKEN_LENGTH = 32;

export function generationRuntimeEnvironment({ environment = process.env, allowEphemeralToken = false } = {}) {
    const source = { ...environment };
    const maintenanceToken = source.VOZEB_PRO_MAINTENANCE_TOKEN?.trim() || "";
    const workerToken = source.VOZEB_PRO_WORKER_TOKEN?.trim() || "";
    if (!allowEphemeralToken && (maintenanceToken.length < MIN_TOKEN_LENGTH || workerToken.length < MIN_TOKEN_LENGTH || maintenanceToken === workerToken)) {
        throw new Error("VOZEB_PRO_MAINTENANCE_TOKEN and VOZEB_PRO_WORKER_TOKEN must be distinct and contain at least 32 characters");
    }

    const port = validPort(source.PORT) || 3000;
    const resolvedMaintenanceToken = maintenanceToken.length >= MIN_TOKEN_LENGTH ? maintenanceToken : randomBytes(32).toString("hex");
    let resolvedWorkerToken = workerToken.length >= MIN_TOKEN_LENGTH ? workerToken : randomBytes(32).toString("hex");
    if (resolvedWorkerToken === resolvedMaintenanceToken) resolvedWorkerToken = randomBytes(32).toString("hex");
    return {
        environment: {
            ...source,
            VOZEB_PRO_MAINTENANCE_TOKEN: resolvedMaintenanceToken,
            VOZEB_PRO_WORKER_TOKEN: resolvedWorkerToken,
            VOZEB_PRO_WORKER_API_ORIGIN: resolveGenerationWorkerOrigin({ environment: source, fallbackOrigin: `http://127.0.0.1:${port}` }),
        },
        ephemeralToken: maintenanceToken.length < MIN_TOKEN_LENGTH || workerToken.length < MIN_TOKEN_LENGTH || maintenanceToken === workerToken,
    };
}

export function resolveGenerationWorkerOrigin({ environment = process.env, fallbackOrigin = "http://127.0.0.1:3000" } = {}) {
    const raw = environment.VOZEB_PRO_WORKER_API_ORIGIN?.trim() || environment.VOZEB_PRO_INTERNAL_ORIGIN?.trim() || environment.NEXT_PUBLIC_SITE_URL?.trim() || fallbackOrigin;
    const value = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Generation worker origin must use HTTP or HTTPS");
    return url.origin;
}

export async function waitForHttpReady({ origin, fetcher = fetch, sleep = retrySleep, signal } = {}) {
    const healthUrl = new URL("/api/health/live", origin).toString();
    let retryMs = 50;
    while (!signal?.aborted) {
        try {
            const response = await fetcher(healthUrl, { signal: AbortSignal.timeout(5_000), cache: "no-store" });
            if (response.ok) return;
        } catch {
            // The app may still be binding its port; keep waiting for its health contract.
        }
        await sleep(retryMs, signal);
        retryMs = Math.min(retryMs * 2, 1_000);
    }
    throw new DOMException("Aborted", "AbortError");
}

export function superviseGenerationRuntime({ app, workerScript, environment }) {
    const workerEnvironment = {};
    for (const key of [
        "PATH",
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "TMPDIR",
        "LANG",
        "LC_ALL",
        "TZ",
        "NODE_ENV",
        "VOZEB_PRO_WORKER_API_ORIGIN",
        "VOZEB_PRO_WORKER_TOKEN",
        "VOZEB_PRO_GENERATION_WORKER_ID",
        "VOZEB_PRO_GENERATION_WORKER_INTERVAL_MS",
        "VOZEB_PRO_GENERATION_WORKER_LANES",
        "VOZEB_PRO_GENERATION_WORKER_HEARTBEAT_MS",
        "VOZEB_PRO_GENERATION_WORKER_MEMORY_MB",
        "VOZEB_PRO_GENERATION_WORKER_HEAP_MB",
        "VOZEB_PRO_GENERATION_WORKER_CPUS",
        "VOZEB_PRO_IMAGE_PROCESS_BUDGET_MB",
        "VOZEB_PRO_IMAGE_PROCESS_HEAP_MB",
        "VOZEB_PRO_IMAGE_PROCESS_CONCURRENCY",
    ]) {
        if (environment[key] !== undefined) workerEnvironment[key] = environment[key];
    }
    const children = [];
    const readinessAbort = new AbortController();
    let workerStarted = false;

    return new Promise((resolve) => {
        let closed = 0;
        let stopping = false;
        let requestedExitCode = 0;

        const cleanup = () => {
            process.off("SIGINT", stopForSignal);
            process.off("SIGTERM", stopForSignal);
            readinessAbort.abort();
        };
        const drain = () => {
            const worker = children.find((child) => child.name === "generation-worker");
            const targets = worker && !worker.closed ? [worker] : children.filter((child) => child.name === "web");
            for (const child of targets) {
                if (child.process.exitCode === null && child.process.signalCode === null) child.process.kill("SIGTERM");
            }
        };
        const stop = (exitCode) => {
            if (stopping) return;
            stopping = true;
            requestedExitCode = exitCode;
            readinessAbort.abort();
            drain();
        };
        const stopForSignal = () => stop(0);

        const registerChild = (definition) => {
            const child = {
                ...definition,
                closed: false,
                process: spawn(definition.command, definition.args, { cwd: definition.cwd, env: definition.environment, stdio: "inherit" }),
            };
            children.push(child);
            child.process.once("error", (error) => {
                console.error(`${child.name} process failed to start`, error);
                stop(1);
            });
            child.process.once("close", (code) => {
                child.closed = true;
                closed += 1;
                if (!stopping) {
                    console.error(`${child.name} process stopped unexpectedly with code ${code ?? "unknown"}`);
                    stop(code && code > 0 ? code : 1);
                }
                if (stopping && code && code > 0) requestedExitCode ||= code;
                if (stopping) drain();
                if (closed === children.length) {
                    cleanup();
                    resolve(requestedExitCode);
                }
            });
            return child;
        };

        process.on("SIGINT", stopForSignal);
        process.on("SIGTERM", stopForSignal);
        const web = registerChild({ name: "web", command: app.command, args: app.args, cwd: app.cwd, environment });
        void waitForHttpReady({ origin: environment.VOZEB_PRO_WORKER_API_ORIGIN, signal: readinessAbort.signal })
            .then(() => {
                if (stopping || workerStarted || web.process.exitCode !== null || web.process.signalCode !== null) return;
                workerStarted = true;
                registerChild({
                    name: "generation-worker",
                    command: process.execPath,
                    args: [`--max-old-space-size=${environment.VOZEB_PRO_GENERATION_WORKER_HEAP_MB || 384}`, workerScript],
                    cwd: app.cwd,
                    environment: workerEnvironment,
                });
            })
            .catch((error) => {
                if (!stopping && !(error instanceof DOMException && error.name === "AbortError")) {
                    console.error("Web health check failed before starting generation worker", error instanceof Error ? error.message : error);
                    stop(1);
                }
            });
    });
}

function retrySleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}

function validPort(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : undefined;
}
