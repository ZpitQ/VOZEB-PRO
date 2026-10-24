import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { request } from "node:https";
import { dirname, isAbsolute, join } from "node:path";
import type { TLSSocket } from "node:tls";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { authenticate } from "../src/credentials.js";
import { initializeStore, openStore } from "../src/store.js";
import { configInput } from "./fixtures.js";
import { tlsTestCertificates } from "./fixtures/tls-certificates.js";
import { transportLimits } from "./http-fixtures.js";
import { recursiveFiles, runnerLimits, sha256, submissionLimits } from "./storage-fixtures.js";
import { runnerAdapterOptions } from "./windows-execution-adapter-runner-fixtures.js";

const workerDirectory = fileURLToPath(new URL("..", import.meta.url));
const control = new URL("./fixtures/worker-main-control.mjs", import.meta.url)
  .href;
const children: ReturnType<typeof child>[] = [];
const syntheticTls = Object.freeze({
  host: "127.0.0.1",
  pfxPath: "C:\\synthetic-main-private\\not-read.pfx",
});

const startupAttempt = "a1111111-1111-4111-8111-111111111111";
const startupNonce = "ab".repeat(32);
const startupArgument = "--startup-observation-v1=" + startupAttempt + ":" + startupNonce;
const earlyStartupFacts = Object.freeze({
  listenerSucceeded: false, recoveryCalled: false, claimEntered: false,
  prepareEntered: false, authorizeEntered: false,
});

function startupPhase(stderr: string) {
  const lines = stderr.split("\n").filter((line) => line.startsWith("ZEB_WORKER_STARTUP_V1 "));
  expect(lines).toHaveLength(1);
  expect(Buffer.byteLength(lines[0]! + "\n", "utf8")).toBeLessThanOrEqual(512);
  const phase: unknown = JSON.parse(lines[0]!.slice("ZEB_WORKER_STARTUP_V1 ".length));
  expect(phase).toBeTruthy();
  expect(Object.keys(phase as object).sort()).toEqual([
    "attempt", "authorizeEntered", "claimEntered", "kind", "listenerSucceeded",
    "nonce", "phase", "prepareEntered", "recoveryCalled", "runnerConstructed", "v",
  ]);
  return phase;
}

async function coldFiles(directory: string) {
  return Promise.all((await recursiveFiles(directory)).sort().map(async (path) => ({
    path, sha256: sha256(await readFile(path)),
  })));
}

function configuration(
  storeDirectory: string,
  port: number,
  pfxPath: string,
  operatorClientId = "11111111-1111-4111-8111-111111111111",
) {
  return {
    storeDirectory,
    port,
    tls: { host: "127.0.0.1", pfxPath },
    operatorClientId,
    selfTestModelId: "standard-4x",
    workerConfig: configInput(),
    submissionLimits,
    runnerLimits,
    transportLimits,
    execution: {
      installationRoot: runnerAdapterOptions.bridge.installationRoot,
      recordsRoot: runnerAdapterOptions.bridge.recordsRoot,
      expectedManifestSha256:
        runnerAdapterOptions.bridge.expectedManifestSha256,
      bridgeLimits: runnerAdapterOptions.bridge.limits,
      journalLimits: runnerAdapterOptions.journalLimits,
    },
  };
}

async function payload() {
  const cache = join(workerDirectory, "node_modules", ".cache");
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(join(cache, "worker-bootstrap-main-"));
  const app = join(root, "app");
  await mkdir(join(app, "dist"), { recursive: true });
  await cp(join(workerDirectory, "main.mjs"), join(app, "main.mjs"));
  await writeFile(join(app, "package.json"), '{"type":"module"}\n', {
    flag: "wx",
  });
  // Preserve every uniquely-owned payload, including failed evidence. Dependency
  // resolution walks upward to the installed worker dependencies; no junction.
  return { root, app, main: join(app, "main.mjs") };
}

function child(
  p: Awaited<ReturnType<typeof payload>>,
  args: readonly string[] = [],
) {
  const updates = new EventEmitter();
  const process = spawn(
    globalThis.process.execPath,
    ["--import", control, p.main, ...args],
    {
      cwd: p.root,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    },
  );
  assert.ok(process.stdout && process.stderr);
  let stdout = "";
  let stderr = "";
  const messages: unknown[] = [];
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let spawnError: Error | undefined;
  process.stdout.on("data", (bytes: Buffer) => {
    stdout += bytes.toString("utf8");
    updates.emit("update");
  });
  process.stderr.on("data", (bytes: Buffer) => {
    stderr += bytes.toString("utf8");
    updates.emit("update");
  });
  process.on("message", (message) => {
    messages.push(message);
    updates.emit("update");
  });
  process.on("error", (error) => {
    spawnError = error;
    updates.emit("update");
  });
  const closed = new Promise<void>((resolve) =>
    process.once("close", (code, signal) => {
      exit = { code, signal };
      updates.emit("update");
      resolve();
    }),
  );

  function waitFor(predicate: () => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        updates.off("update", check);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        if (predicate()) finish();
        else if (spawnError || exit)
          finish(new Error("main child ended before its expected test event"));
      };
      // Test failure bound only; this does not implement a product watchdog.
      const timer = setTimeout(
        () => finish(new Error("main child event was not observed")),
        5_000,
      );
      updates.on("update", check);
      check();
    });
  }

  return {
    process,
    closed,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    get exit() {
      return exit;
    },
    get messages() {
      return messages;
    },
    line(event: string) {
      return waitFor(() => stdout.split(/\r?\n/).includes(event));
    },
    errorLine(event: string) {
      return waitFor(() => stderr.split(/\r?\n/).includes(event));
    },
    message(event: string) {
      return waitFor(() =>
        messages.some(
          (message) =>
            !!message &&
            typeof message === "object" &&
            "event" in message &&
            message.event === event,
        ),
      );
    },
    async ended() {
      await waitFor(() => exit !== undefined);
      await closed;
      return exit;
    },
  };
}

function run(
  p: Awaited<ReturnType<typeof payload>>,
  args: readonly string[] = [],
) {
  const running = child(p, args);
  children.push(running);
  return running;
}

afterEach(async () => {
  for (const running of children.splice(0)) {
    if (running.exit === undefined) running.process.kill();
    await running.closed;
  }
});

const controlledBootstrap = `
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
export async function startWindowsWorker(configuration, options) {
  if (configuration.marker !== "sibling-config" ||
      options.appDirectory !== dirname(dirname(fileURLToPath(import.meta.url))) ||
      options.signal.aborted) throw new Error("synthetic-private-configuration");
  options.signal.addEventListener("abort", () => process.stdout.write("fixture_aborted\\n"), { once: true });
  process.send?.({ event: "bootstrap_entered" });
  const message = (name) => new Promise((resolve) => {
    const receive = (value) => { if (value === name) { process.off("message", receive); resolve(); } };
    process.on("message", receive);
  });
  let observedBytes = 0;
  const observedInput = (bytes) => {
    observedBytes += bytes.length;
    process.send?.({ event: observedBytes >= 23 ? "fixture_frame_observed" : "fixture_input_" + observedBytes });
    if (observedBytes >= 23) process.stdin.off("data", observedInput);
  };
  // The observer only counts bytes already delivered to main's earlier data listener.
  process.stdin.on("data", observedInput);
  if (configuration.pending === "controlled") await message("publish_runtime");
  else if (configuration.pending) await new Promise(() => {});
  if (configuration.startupPhase) await options.onStartupObservation(configuration.startupPhase);
  let calls = 0;
  return { server: {}, close() {
    process.stdout.write("fixture_closed\\n");
    return new Promise(() => {});
  }, shutdown(deadlineAt) {
    process.send?.({ event: "shutdown_called", calls: ++calls, deadlineAt, observedNow: performance.now() });
    if (configuration.shutdown === "reject") return Promise.reject(new Error("synthetic-private-shutdown-error"));
    if (configuration.shutdown === "controlled") return message("finish_shutdown").then(() => "closed");
    return Promise.resolve(configuration.shutdown === "unknown" ? "unknown" : "closed");
  } };
}
`;

async function controlled(
  p: Awaited<ReturnType<typeof payload>>,
  overrides: object = {},
) {
  await writeFile(
    join(p.app, "worker.config.json"),
    JSON.stringify({
      port: 32_001,
      tls: syntheticTls,
      marker: "sibling-config",
      ...overrides,
    }),
    { flag: "wx" },
  );
  await writeFile(join(p.app, "dist", "bootstrap.js"), controlledBootstrap, {
    flag: "wx",
  });
}

describe("fixed Windows worker main boundary", () => {
  it.each([
    "cli",
    "missing-config",
    "invalid-json",
    "missing-module",
    "module-load",
  ])(
    "sanitizes %s startup failure, including module evaluation failures",
    async (mode) => {
      const p = await payload();
      if (mode === "cli") await controlled(p);
      else if (mode === "invalid-json")
        await writeFile(
          join(p.app, "worker.config.json"),
          '{"private":"synthetic-main-private-value",',
          { flag: "wx" },
        );
      else if (mode === "missing-module" || mode === "module-load") {
        await writeFile(
          join(p.app, "worker.config.json"),
          JSON.stringify({ port: 32001, tls: syntheticTls }) + "\n",
          {
            flag: "wx",
          },
        );
        if (mode === "module-load")
          await writeFile(
            join(p.app, "dist", "bootstrap.js"),
            'throw new Error("synthetic-main-private-value");\n',
            { flag: "wx" },
          );
      }
      const running = run(
        p,
        mode === "cli" ? ["--config=synthetic-main-private-value"] : [],
      );
      expect(await running.ended()).toEqual({ code: 2, signal: null });
      expect(running.stdout === "").toBe(true);
      expect(running.stderr === "enhancement_worker_start_failed\n").toBe(true);
      expect(isDeepStrictEqual(running.messages, [])).toBe(true);
    },
    10_000,
  );

  it.each([0, -1, 65_536, 1.5, "32001", null, undefined])(
    "rejects formal port %s before starting the configured runtime",
    async (port) => {
      const p = await payload();
      await controlled(p, { port });
      const running = run(p);
      expect(await running.ended()).toEqual({ code: 2, signal: null });
      expect(running.stderr === "enhancement_worker_start_failed\n").toBe(true);
      expect(running.stdout === "").toBe(true);
      expect(isDeepStrictEqual(running.messages, [])).toBe(true);
    },
    10_000,
  );

  it.each(["stop", "interrupt"])(
    "uses its own sibling config and fixed dist import, then explicitly exits on %s despite live handles and pending cleanup",
    async (signal) => {
      const p = await payload();
      await controlled(p);
      await writeFile(
        join(p.root, "worker.config.json"),
        '{"marker":"wrong-cwd"}\n',
        { flag: "wx" },
      );
      const running = run(p);
      await running.line("enhancement_worker_listening");
      running.process.send(signal);
      expect(await running.ended()).toEqual({ code: 0, signal: null });
      expect(running.stderr === "").toBe(true);
      expect(
        running.stdout ===
          "enhancement_worker_listening\nfixture_aborted\nfixture_closed\n",
      ).toBe(true);
    },
    10_000,
  );

  it("installs stop handling before a pending bootstrap and explicitly exits after sealing its signal", async () => {
    const p = await payload();
    await controlled(p, { pending: true });
    const running = run(p);
    await running.message("bootstrap_entered");
    running.process.send("stop");
    expect(await running.ended()).toEqual({ code: 0, signal: null });
    expect(running.stderr === "").toBe(true);
    expect(running.stdout === "fixture_aborted\n").toBe(true);
  }, 10_000);

  it.each(["fatal", "rejection"])(
    "seals and exits with a sanitized runtime error on %s",
    async (event) => {
      const p = await payload();
      await controlled(p);
      const running = run(p);
      await running.line("enhancement_worker_listening");
      running.process.send(event);
      expect(await running.ended()).toEqual({ code: 2, signal: null });
      expect(running.stderr === "enhancement_worker_failed\n").toBe(true);
      expect(
        running.stdout ===
          "enhancement_worker_listening\nfixture_aborted\nfixture_closed\n",
      ).toBe(true);
    },
    10_000,
  );

  it.each(["whole", "split", "adjacent-repeat"] as const)("accepts only one graceful shutdown for a %s fixed frame", async (mode) => {
    const p = await payload();
    await controlled(p, { shutdown: "controlled" });
    const running = run(p);
    await running.line("enhancement_worker_listening");
    const frame = Buffer.from("ZEB_WORKER_SHUTDOWN_V1\n", "ascii");
    if (mode === "split") {
      running.process.stdin!.write(frame.subarray(0, 7));
      await running.message("fixture_input_7");
      expect(running.messages.some((value: any) => value.event === "shutdown_called")).toBe(false);
      running.process.stdin!.write(frame.subarray(7));
    } else running.process.stdin!.write(mode === "adjacent-repeat" ? Buffer.concat([frame, frame]) : frame);
    await running.message("shutdown_called");
    const invoked = running.messages.find((value: any) => value.event === "shutdown_called") as any;
    expect(invoked.calls).toBe(1);
    expect(invoked.deadlineAt - invoked.observedNow).toBeGreaterThan(24_000);
    expect(invoked.deadlineAt - invoked.observedNow).toBeLessThanOrEqual(25_000);
    expect(running.stdout).not.toContain("fixture_aborted");
    expect(running.stdout).not.toContain("fixture_closed");
    running.process.send("finish_shutdown");
    expect(await running.ended()).toEqual({ code: 0, signal: null });
    expect(running.messages.filter((value: any) => value.event === "shutdown_called")).toHaveLength(1);
    expect(running.stderr).toBe("");
  }, 10_000);

  it.each(["unknown", "reject", "late-closed"] as const)("keeps %s graceful outcome nonzero and never aborts first", async (mode) => {
    const p = await payload();
    await controlled(p, { shutdown: mode === "late-closed" ? "controlled" : mode });
    const running = run(p);
    await running.line("enhancement_worker_listening");
    running.process.stdin!.write("ZEB_WORKER_SHUTDOWN_V1\n");
    await running.message("shutdown_called");
    if (mode === "late-closed") {
      running.process.send({ event: "advance-main-clock", milliseconds: 25_001, tag: "late" });
      await running.message("main_clock_late");
      running.process.send("finish_shutdown");
    }
    await running.errorLine("enhancement_worker_shutdown_unknown");
    running.process.send({ event: "main-state", tag: "unknown" });
    await running.message("main_state_unknown");
    const state = running.messages.find((value: any) => value.event === "main_state_unknown") as any;
    expect(state.exitCode).toBe(2);
    expect(running.exit).toBeUndefined();
    expect(running.stdout).not.toContain("fixture_aborted");
    expect(running.stdout).not.toContain("fixture_closed");
    expect(running.stderr).toBe("enhancement_worker_shutdown_unknown\n");
    running.process.send("stop");
    expect(await running.ended()).toEqual({ code: 2, signal: null });
  }, 10_000);

  it.each(["crlf", "garbage", "partial-eof", "empty-eof"] as const)("rejects %s on the private graceful control pipe", async (mode) => {
    const p = await payload();
    await controlled(p, { shutdown: "controlled" });
    const running = run(p);
    await running.line("enhancement_worker_listening");
    if (mode === "crlf") running.process.stdin!.write("ZEB_WORKER_SHUTDOWN_V1\r\n");
    else if (mode === "garbage") running.process.stdin!.write(Buffer.from([255]));
    else running.process.stdin!.end(mode === "partial-eof" ? "ZEB_WORKER_" : undefined);
    expect(await running.ended()).toEqual({ code: 2, signal: null });
    expect(running.stderr).toBe("enhancement_worker_control_failed\n");
    expect(running.messages.some((value: any) => value.event === "shutdown_called")).toBe(false);
  }, 10_000);

  it.each(["timely", "expired"] as const)("uses the original cutoff on a %s late runtime publication", async (mode) => {
    const p = await payload();
    await controlled(p, { pending: "controlled", shutdown: "controlled" });
    const running = run(p);
    await running.message("bootstrap_entered");
    running.process.stdin!.write("ZEB_WORKER_SHUTDOWN_V1\nZEB_WORKER_SHUTDOWN_V1\n");
    await running.message("fixture_frame_observed");
    running.process.send({ event: "main-state", tag: "pending" });
    await running.message("main_state_pending");
    const before = running.messages.find((value: any) => value.event === "main_state_pending") as any;
    expect(before.exitCode).toBe(2);
    expect(running.stdout).not.toContain("fixture_aborted");
    if (mode === "expired") {
      running.process.send({ event: "advance-main-clock", milliseconds: 25_001, tag: "startup" });
      await running.message("main_clock_startup");
    }
    running.process.send("publish_runtime");
    await running.message("shutdown_called");
    const invoked = running.messages.find((value: any) => value.event === "shutdown_called") as any;
    expect(invoked.calls).toBe(1);
    expect(invoked.deadlineAt).toBeLessThanOrEqual(before.now + 25_000);
    if (mode === "expired") expect(invoked.deadlineAt).toBeLessThan(invoked.observedNow);
    else expect(invoked.deadlineAt).toBeGreaterThan(invoked.observedNow);
    expect(running.stdout).not.toContain("enhancement_worker_listening");
    running.process.send("finish_shutdown");
    if (mode === "expired") {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(running.exit).toBeUndefined();
      running.process.send("stop");
    }
    expect(await running.ended()).toEqual({ code: mode === "timely" ? 0 : 2, signal: null });
    expect(running.messages.filter((value: any) => value.event === "bootstrap_entered")).toHaveLength(1);
    expect(running.messages.filter((value: any) => value.event === "shutdown_called")).toHaveLength(1);
  }, 10_000);

  it("accepts internal HTTP without a TLS gate and delegates to the normal bootstrap", async () => {
    const p = await payload();
    await writeFile(
      join(p.app, "worker.config.json"),
      JSON.stringify({
        host: "127.0.0.1",
        port: 32_001,
        marker: "sibling-config",
      }),
      { flag: "wx" },
    );
    await writeFile(
      join(p.app, "dist", "bootstrap.js"),
      `process.send?.({ event: "tls_gate_module_evaluated" });
${controlledBootstrap}`,
      { flag: "wx" },
    );
    const running = run(p);
    const evaluated = await Promise.race([
      running.message("tls_gate_module_evaluated").then(
        () => true,
        () => running.closed.then(() => false),
      ),
      running.closed.then(() => false),
    ]);
    expect(
      evaluated,
      "HTTP delegates configuration validation to the real bootstrap boundary",
    ).toBe(true);
    await running.line("enhancement_worker_listening");
    running.process.send("stop");
    expect(await running.ended()).toEqual({ code: 0, signal: null });
    expect(running.stderr).toBe("");
  }, 10_000);

  it.each([
    ["--startup-observation-v1="],
    ["--startup-observation-v1=" + startupAttempt.toUpperCase() + ":" + startupNonce],
    ["--startup-observation-v1=" + startupAttempt + ":" + startupNonce.toUpperCase()],
    ["--startup-observation-v1=" + startupAttempt + ":" + startupNonce.slice(1)],
    [startupArgument + ":extra"],
    [startupArgument, startupArgument],
    [startupArgument, "--extra"],
  ])("rejects noncanonical or duplicate observation arguments before bootstrap: %j", async (...args) => {
    const p = await payload();
    await controlled(p);
    const running = run(p, args);
    expect(await running.ended()).toEqual({ code: 2, signal: null });
    expect(running.stdout).toBe("");
    expect(running.stderr).toBe("enhancement_worker_start_failed\n");
    expect(running.messages).toEqual([]);
  }, 10_000);
});

async function vacantPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function get(port: number, path: string, authorization: string, tls = true) {
  return new Promise<{ status: number; body: any; authorized: boolean | undefined }>(
    (resolve, reject) => {
      const req = (tls ? request : httpRequest)(
        {
          host: "127.0.0.1",
          port,
          path,
          headers: { authorization },
          ca: tlsTestCertificates.localhost.ca,
          servername: "localhost",
          rejectUnauthorized: true,
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          const authorized = tls ? (res.socket as TLSSocket).authorized : undefined;
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.once("error", () =>
            reject(new Error("main HTTPS response failed")),
          );
          res.once("end", () => {
            try {
              resolve({
                status: res.statusCode!,
                body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
                authorized,
              });
            } catch {
              reject(new Error("main HTTPS fixture expected JSON"));
            }
          });
        },
      );
      req.once("error", () => reject(new Error("main HTTPS request failed")));
      req.end();
    },
  );
}

describe.skipIf(process.platform !== "win32")(
  "actual dist Windows worker main",
  () => {
    async function actualHttpPayload(port = 0) {
      const p = await payload();
      await cp(join(workerDirectory, "dist"), join(p.app, "dist"), { recursive: true });
      const directory = join(p.root, "store");
      const initialized = initializeStore({ directory, clock: Date.now });
      initialized.store.close();
      const recordsRoot = join(p.root, "records");
      await mkdir(recordsRoot);
      const input: Record<string, unknown> = configuration(
        directory, port || await vacantPort(), "", initialized.credential.clientId,
      );
      delete input.tls;
      input.host = "127.0.0.1";
      input.execution = { ...(input.execution as object), recordsRoot };
      await writeFile(join(p.app, "worker.config.json"), JSON.stringify(input), { flag: "wx" });
      return { ...p, directory, recordsRoot, port: input.port as number, initialized };
    }

    it.each(["bind", "schema"] as const)(
      "emits one complete typed %s phase from actual main/bootstrap/Store, exits 2, and preserves owned evidence",
      async (mode) => {
        const blocker = createServer();
        try {
          let port = 0;
          if (mode === "bind") {
            await new Promise<void>((resolve, reject) => {
              blocker.once("error", reject);
              blocker.listen(0, "127.0.0.1", resolve);
            });
            const address = blocker.address();
            assert.ok(address && typeof address !== "string");
            port = address.port;
          }
          const p = await actualHttpPayload(port);
          if (mode === "schema") {
            const db = new Database(join(p.directory, "worker.sqlite"), { fileMustExist: true });
            try { db.pragma("user_version = 8"); } finally { db.close(); }
          }
          const beforeStore = mode === "schema" ? await coldFiles(p.directory) : undefined;
          const beforeRecords = await coldFiles(p.recordsRoot);
          const running = run(p, [startupArgument]);
          expect(await running.ended()).toEqual({ code: 2, signal: null });
          expect(running.stdout).toBe("");
          expect(startupPhase(running.stderr)).toEqual({
            v: 1, kind: "startup_phase", attempt: startupAttempt, nonce: startupNonce,
            phase: mode === "bind" ? "listener_bind_failed" : "store_schema_incompatible",
            runnerConstructed: mode === "bind", ...earlyStartupFacts,
          });
          expect(running.stderr.split("\n").filter(Boolean)).toHaveLength(2);
          expect(running.stderr.endsWith("enhancement_worker_start_failed\n")).toBe(true);
          expect(running.stderr).not.toContain(p.root);
          expect(running.stderr).not.toContain(p.initialized.credential.key);
          expect(await coldFiles(p.recordsRoot)).toEqual(beforeRecords);
          if (mode === "schema") {
            expect(await coldFiles(p.directory)).toEqual(beforeStore);
            expect(() => openStore({ directory: p.directory, clock: Date.now }))
              .toThrow(expect.objectContaining({ code: "configuration_invalid", status: 503 }));
            expect(await coldFiles(p.directory)).toEqual(beforeStore);
          }
        } finally {
          if (blocker.listening) await new Promise<void>((resolve, reject) =>
            blocker.close((error) => error ? reject(error) : resolve()));
        }
      }, 15_000,
    );

    it.skipIf(process.env.ZEB_WINDOWS_SERVICE_HOST_OS_TESTS !== "1").each(["bind", "schema", "ready"] as const)(
      "Host fourth frame: actual %s Worker phase survives original ownership and observation close",
      async (mode) => {
        const fixture = process.env.ZEB_WINDOWS_SERVICE_HOST_FIXTURE_EXE;
        assert.ok(fixture && isAbsolute(fixture), "an explicitly built Host fixture is required");
        const blocker = createServer();
        let fixtureChild: ReturnType<typeof spawn> | undefined;
        let closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
        let watchdog: NodeJS.Timeout | undefined;
        let guardianUsed = false;
        try {
          let port = 0;
          if (mode === "bind") {
            await new Promise<void>((resolve, reject) => {
              blocker.once("error", reject); blocker.listen(0, "127.0.0.1", resolve);
            });
            const address = blocker.address(); assert.ok(address && typeof address !== "string"); port = address.port;
          }
          const p = await actualHttpPayload(port);
          if (mode === "schema") {
            const db = new Database(join(p.directory, "worker.sqlite"), { fileMustExist: true });
            try { db.pragma("user_version = 8"); } finally { db.close(); }
          }
          const beforeStore = mode === "schema" ? await coldFiles(p.directory) : undefined;
          const beforeRecords = await coldFiles(p.recordsRoot);
          const evidence = join(p.root, "host-final-evidence"); await mkdir(evidence);
          const artifacts = [fixture, join(dirname(fixture), "WindowsServiceHostFixture.dll"),
            join(dirname(fixture), "WindowsServiceHost.dll"), join(dirname(fixture), "WindowsSupervisor.dll"),
            process.execPath, p.main, join(p.app, "dist", "bootstrap.js"), join(p.app, "dist", "store.js"),
            join(p.app, "worker.config.json")];
          const beforeArtifacts = await Promise.all(artifacts.map(async (path) => sha256(await readFile(path))));
          await writeFile(join(p.root, "host-final-preflight.json"), JSON.stringify({ mode, beforeStore, beforeRecords, artifacts, beforeArtifacts }), { flag: "wx" });
          const running = spawn(fixture, ["startup-final-case", mode, evidence, process.execPath, p.main, "10000", "5000"], {
            cwd: evidence, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"],
          });
          fixtureChild = running;
          assert.ok(running.stdin && running.stdout && running.stderr);
          const stdout: Buffer[] = [], stderr: Buffer[] = [], errors: string[] = [];
          let bytes = 0, stdoutEof = false, stderrEof = false;
          let ended: { code: number | null; signal: NodeJS.Signals | null } | undefined;
          running.stdin.on("error", () => errors.push("fixture stdin failed"));
          for (const [stream, capture] of [[running.stdout, stdout], [running.stderr, stderr]] as const) {
            stream.on("data", (chunk: Buffer) => { bytes += chunk.length;
              if (bytes <= 1_048_576) capture.push(Buffer.from(chunk)); else errors.push("fixture capture exceeded bound"); });
            stream.on("error", () => errors.push("fixture output failed"));
          }
          running.stdout.once("end", () => { stdoutEof = true; });
          running.stderr.once("end", () => { stderrEof = true; });
          closed = new Promise((resolve) => {
            running.once("error", () => { errors.push("fixture spawn failed"); ended = { code: null, signal: null }; resolve(ended); });
            running.once("close", (code, signal) => { ended = { code, signal }; resolve(ended); });
          });
          watchdog = setTimeout(() => { guardianUsed = true; running.kill(); }, 20_000);
          let health: Awaited<ReturnType<typeof get>> | undefined;
          let healthFailure: string | undefined;
          if (mode === "ready") {
            let observed = false;
            while (!ended) {
              observed = await readFile(join(evidence, "startup-final-ready-observed.json"), "utf8").then(() => true, (error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return false; throw error;
              });
              if (observed) break;
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
            if (observed) {
              try { health = await get(p.port, "/healthz", "Bearer " + p.initialized.credential.key, false); }
              catch (failure) { healthFailure = failure instanceof Error ? failure.name : "unknown"; }
              finally { running.stdin.end("stop\n"); }
            }
          } else running.stdin.end();
          const result = await closed;
          clearTimeout(watchdog);
          const afterRecords = await coldFiles(p.recordsRoot);
          const afterStore = mode === "schema" ? await coldFiles(p.directory) : undefined;
          const afterArtifacts = await Promise.all(artifacts.map(async (path) => sha256(await readFile(path))));
          await writeFile(join(p.root, "host-final-postflight.json"), JSON.stringify({ result, guardianUsed, afterStore, afterRecords, afterArtifacts,
            healthFailure, healthStatus: health?.status, healthAlive: health?.body?.data?.alive }), { flag: "wx" });
          expect(guardianUsed).toBe(false); expect(errors).toEqual([]);
          expect(stdoutEof && stderrEof).toBe(true);
          expect(Buffer.concat(stderr).toString("utf8")).toBe("");
          const receipt = JSON.parse(Buffer.concat(stdout).toString("utf8"));
          expect(JSON.parse(await readFile(join(evidence, "service-host-evidence.json"), "utf8"))).toEqual(receipt);
          expect(receipt.passed, JSON.stringify(receipt.failures)).toBe(true);
          expect(result).toEqual({ code: 0, signal: null });
          expect(receipt).toMatchObject({ scenario: mode, guardianUsed: false, originalsJoined: true, observationEof: true,
            crossSidScmAccepted: false, explicitStop: mode === "ready", safetyTree: { activeProcesses: 0 },
            hostPin: { originalRetained: true, originalJoined: true, alive: false },
            nodePin: { originalRetained: true, originalJoined: true, alive: false },
            completed: { physicalCleanup: true, secondStartRejected: true, explicitStop: mode === "ready" },
            final: { kind: mode === "ready" ? "ready" : "settled", seq: 4 },
          });
          if (mode !== "ready") {
            expect(receipt).toMatchObject({ nodePin: { exitCode: 2 }, final: {
              sealed: true, ownerReleasedTreeActive: 0, cleanupFailureCount: 0, ownerReleaseCompleted: true,
              cleanup: { rootExit: { exitCode: 2 }, treeExit: { activeProcesses: 0 },
                stdout: { eof: true, readFailureType: null, sinkFailureType: null },
                stderr: { eof: true, readFailureType: null, sinkFailureType: null } } },
              completed: { startupSettlement: { cleanupFailureCount: 0, ownerReleaseCompleted: true } } });
            for (const field of ["cleanupFailureCount", "ownerReleaseCompleted"])
              expect(receipt.final[field]).toEqual(receipt.completed.startupSettlement[field]);
          } else {
            expect(Object.hasOwn(receipt.final, "cleanupFailureCount")).toBe(false);
            expect(Object.hasOwn(receipt.final, "ownerReleaseCompleted")).toBe(false);
          }
          expect(afterRecords).toEqual(beforeRecords);
          if (mode === "schema") expect(afterStore).toEqual(beforeStore);
          expect(afterArtifacts).toEqual(beforeArtifacts);
          if (mode === "ready") {
            expect(healthFailure).toBeUndefined();
            expect(health?.status).toBe(200);
            expect(health?.body).toMatchObject({ code: "ok", data: { alive: true } });
          }
        } finally {
          if (fixtureChild && fixtureChild.exitCode === null && fixtureChild.signalCode === null)
            fixtureChild.stdin?.end("stop\n");
          try { if (closed) await closed; } finally { if (watchdog) clearTimeout(watchdog); }
          if (blocker.listening) await new Promise<void>((resolve, reject) => blocker.close((error) => error ? reject(error) : resolve()));
        }
      }, 30_000,
    );

    it.skipIf(process.env.ZEB_WINDOWS_SERVICE_HOST_OS_TESTS !== "1")(
      "Host startup cleanup reference controls: excludes only exit2 root exception and retains unrelated failures",
      async () => {
        const fixture = process.env.ZEB_WINDOWS_SERVICE_HOST_FIXTURE_EXE;
        assert.ok(fixture && isAbsolute(fixture), "an explicitly built Host fixture is required");
        const cache = join(workerDirectory, "node_modules", ".cache");
        await mkdir(cache, { recursive: true });
        const directory = await mkdtemp(join(cache, "startup-cleanup-controls-"));
        const result = spawnSync(fixture, ["startup-cleanup-controls", directory], {
          cwd: directory, windowsHide: true, shell: false, encoding: "utf8", timeout: 10_000, maxBuffer: 1_048_576,
          stdio: ["ignore", "pipe", "pipe"],
        });
        expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.stderr).toBe("");
        const receipt = JSON.parse(result.stdout);
        expect(JSON.parse(await readFile(join(directory, "service-host-evidence.json"), "utf8"))).toEqual(receipt);
        expect(receipt.caseCount).toBe(2);
        expect(receipt.cases.map((value: { name: string }) => value.name)).toEqual([
          "exit2_excludes_only_original_root_exception_reference", "exit3_root_failure_remains_counted",
        ]);
        expect(receipt.passed, JSON.stringify(receipt.cases)).toBe(true);
        for (const value of receipt.cases) expect(value).toMatchObject({ fieldsPresent: true, countMatches: true,
          releaseMatches: true, originalReferencesRetained: true, sameTypeAndMessageIndependent: true,
          completionRemainsFaulted: true, passed: true, failurePoint: null });
        expect(receipt).toMatchObject({ actualWorkerStarted: false, actualNodeExit: false, actualOwnerReleased: false,
          actualScm: false, actualFailureProof: false });
        expect(result.status).toBe(0);
      }, 15_000,
    );

    it.skipIf(process.env.ZEB_WINDOWS_SERVICE_HOST_OS_TESTS !== "1")(
      "Host startup phase parser: retains Unknown for malformed or missing diagnostics",
      async () => {
        const fixture = process.env.ZEB_WINDOWS_SERVICE_HOST_FIXTURE_EXE;
        assert.ok(fixture && isAbsolute(fixture), "an explicitly built Host fixture is required");
        const cache = join(workerDirectory, "node_modules", ".cache");
        await mkdir(cache, { recursive: true });
        const directory = await mkdtemp(join(cache, "startup-phase-controls-"));
        const running = spawn(fixture, ["startup-phase-controls", directory], {
          cwd: directory, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"],
        });
        const stdout: Buffer[] = [], stderr: Buffer[] = [], errors: string[] = [];
        let bytes = 0, stdoutEof = false, stderrEof = false, guardianUsed = false;
        for (const [stream, capture] of [[running.stdout, stdout], [running.stderr, stderr]] as const) {
          stream.on("data", (chunk: Buffer) => { bytes += chunk.length;
            if (bytes <= 1_048_576) capture.push(Buffer.from(chunk)); else errors.push("parser control capture exceeded bound"); });
          stream.on("error", () => errors.push("parser control output failed"));
        }
        running.stdout.once("end", () => { stdoutEof = true; });
        running.stderr.once("end", () => { stderrEof = true; });
        const watchdog = setTimeout(() => { guardianUsed = true; running.kill(); }, 10_000);
        let result: { code: number | null; signal: NodeJS.Signals | null };
        try {
          result = await new Promise((resolve, reject) => {
            running.once("error", reject); running.once("close", (code, signal) => resolve({ code, signal }));
          });
        } finally { clearTimeout(watchdog); }
        expect(guardianUsed).toBe(false); expect(errors).toEqual([]); expect(stdoutEof && stderrEof).toBe(true);
        expect(Buffer.concat(stderr).toString("utf8")).toBe("");
        const receipt = JSON.parse(Buffer.concat(stdout).toString("utf8"));
        expect(JSON.parse(await readFile(join(directory, "service-host-evidence.json"), "utf8"))).toEqual(receipt);
        expect(receipt.passed, JSON.stringify(receipt.cases)).toBe(true); expect(receipt.caseCount).toBe(14);
        expect(result).toEqual({ code: 0, signal: null });
        expect(receipt.cases.map((value: { name: string }) => value.name)).toEqual([
          "valid-split-and-long-log", "valid-512-boundary", "invalid-utf8", "unknown-key", "duplicate-key",
          "wrong-nonce", "wrong-attempt", "nonboolean", "contradictory-listening-state", "repeated-phase",
          "over-512", "no-phase-eof", "partial-phase-eof", "valid-then-partial-phase-eof",
        ]);
        for (const value of receipt.cases) expect(value).toMatchObject({ passed: true, failureTiming: true, missingClassified: true, eofRetained: true,
          failureRetained: true, noFinalClaim: true, accepted: value.expectedAccepted });
      }, 15_000,
    );

    it("does not label a missing actual Store as schema or listener failure", async () => {
      const p = await actualHttpPayload();
      const input = JSON.parse(await readFile(join(p.app, "worker.config.json"), "utf8"));
      input.storeDirectory = join(p.root, "missing-store");
      await writeFile(join(p.app, "worker.config.json"), JSON.stringify(input));
      const running = run(p, [startupArgument]);
      expect(await running.ended()).toEqual({ code: 2, signal: null });
      expect(startupPhase(running.stderr)).toEqual({
        v: 1, kind: "startup_phase", attempt: startupAttempt, nonce: startupNonce,
        phase: "unknown", runnerConstructed: false, ...earlyStartupFacts,
      });
      expect(running.stdout).toBe("");
    }, 15_000);

    it("emits listening once from real bootstrap, stays usable, and keeps fixed shutdown unchanged", async () => {
      const p = await actualHttpPayload();
      const running = run(p, [startupArgument]);
      await running.line("enhancement_worker_listening");
      const phase = startupPhase(running.stderr);
      expect(phase).toEqual({
        v: 1, kind: "startup_phase", attempt: startupAttempt, nonce: startupNonce,
        phase: "listening", runnerConstructed: true, ...earlyStartupFacts,
        listenerSucceeded: true,
      });
      const health = await get(p.port, "/healthz", "Bearer " + p.initialized.credential.key, false);
      expect(health.status).toBe(200);
      expect(health.body).toMatchObject({ code: "ok", data: { alive: true } });
      running.process.stdin!.write("ZEB_WORKER_SHUTDOWN_V1\n");
      expect(await running.ended()).toEqual({ code: 0, signal: null });
      expect(startupPhase(running.stderr)).toEqual(phase);
      expect(running.stderr.split("\n").filter(Boolean)).toHaveLength(1);
    }, 15_000);

    // These cases exercise only main's output callback; the real phase paths above
    // never use the controlled bootstrap or a fabricated failure classification.
    it.each(["release", "error", "timeout"] as const)(
      "waits for one diagnostic write callback and keeps %s outcome bounded",
      async (mode) => {
        const p = await payload();
        await controlled(p, { pending: "controlled", startupPhase: {
          phase: "listening", runnerConstructed: true, ...earlyStartupFacts,
          listenerSucceeded: true,
        } });
        const running = run(p, [startupArgument]);
        await running.message("bootstrap_entered");
        running.process.send({ event: "startup-write-control", mode });
        await running.message("startup_write_armed");
        running.process.send("publish_runtime");
        await running.message("startup_write_seen");
        const writeObservedAt = performance.now();
        if (mode === "release") {
          running.process.send({ event: "main-state", tag: "write_pending" });
          await running.message("main_state_write_pending");
          expect(running.exit).toBeUndefined();
          expect(running.stdout).not.toContain("enhancement_worker_listening");
          running.process.send("release_startup_write");
          await running.line("enhancement_worker_listening");
          startupPhase(running.stderr);
          running.process.send("stop");
          expect(await running.ended()).toEqual({ code: 0, signal: null });
        } else {
          expect(await running.ended()).toEqual({ code: 2, signal: null });
          expect(performance.now() - writeObservedAt).toBeLessThan(2_000);
          expect(running.stdout).not.toContain("enhancement_worker_listening");
          expect(running.stderr).not.toContain("synthetic-private-write-error");
          expect(running.stderr).not.toContain("ZEB_WORKER_STARTUP_V1 ");
        }
        expect(running.messages.filter((value: any) => value.event === "startup_write_seen")).toHaveLength(1);
      }, 10_000,
    );

    it.each(["http", "https"] as const)("opens an initialized empty Store through actual dist/bootstrap over %s, serves authenticated APIs with ready=false, then retains identity and credentials on stop", async (transport) => {
      const tls = transport === "https";
      const p = await payload();
      await cp(join(workerDirectory, "dist"), join(p.app, "dist"), {
        recursive: true,
      });
      // The real build is required; a missing or stub build cannot satisfy this test.
      expect(
        (await readFile(join(p.app, "dist", "bootstrap.js"), "utf8")).includes(
          "startWindowsWorker",
        ),
      ).toBe(true);
      const pfxPath = join(p.app, "main-test-only.pfx");
      if (tls) await writeFile(pfxPath, tlsTestCertificates.localhost.pfx, {
        flag: "wx",
      });
      const directory = join(p.root, "store");
      const initialized = initializeStore({ directory, clock: Date.now });
      const serviceId = initialized.store.identity.serviceId;
      const authorization = `Bearer ${initialized.credential.key}`;
      const principal = authenticate(initialized.store, authorization);
      initialized.store.close();
      const port = await vacantPort();
      const input: Record<string, unknown> = configuration(directory, port, pfxPath, initialized.credential.clientId);
      if (!tls) { delete input.tls; input.host = "127.0.0.1"; }
      await writeFile(
        join(p.app, "worker.config.json"),
        JSON.stringify(input),
        { flag: "wx" },
      );
      const running = run(p);
      await running.line("enhancement_worker_listening");
      const health = await get(port, "/healthz", authorization, tls);
      expect(health.authorized).toBe(tls ? true : undefined);
      expect(
        isDeepStrictEqual(
          {
            status: health.status,
            code: health.body?.code,
            alive: health.body?.data?.alive,
          },
          { status: 200, code: "ok", alive: true },
        ),
      ).toBe(true);
      const capabilities = await get(port, "/v1/capabilities", authorization, tls);
      expect(capabilities.authorized).toBe(tls ? true : undefined);
      expect(
        isDeepStrictEqual(
          {
            status: capabilities.status,
            serviceId: capabilities.body?.data?.serviceId,
            ready: capabilities.body?.data?.ready,
            reason: capabilities.body?.data?.reason,
          },
          {
            status: 200,
            serviceId,
            ready: false,
            reason: "runner_unavailable",
          },
        ),
      ).toBe(true);
      const unauthorized = await get(
        port,
        "/healthz",
        "Bearer invalid-fixture-key",
        tls,
      );
      expect(unauthorized.authorized).toBe(tls ? true : undefined);
      expect(unauthorized.status).toBe(401);
      running.process.stdin!.write("ZEB_WORKER_SHUTDOWN_V1\n");
      expect(await running.ended()).toEqual({ code: 0, signal: null });
      expect(running.stderr === "").toBe(true);
      expect(running.stdout === "enhancement_worker_listening\n").toBe(true);
      const reopened = openStore({ directory, clock: Date.now });
      try {
        expect(reopened.identity.serviceId === serviceId).toBe(true);
        expect(
          isDeepStrictEqual(authenticate(reopened, authorization), principal),
        ).toBe(true);
        expect(
          reopened.claimNext("post-stop-inspection-owner") === undefined,
        ).toBe(true);
        expect(
          reopened.beginRecovery("post-stop-inspection-owner") === undefined,
        ).toBe(true);
      } finally {
        reopened.close();
      }
    }, 15_000);

    it("rejects a missing real PFX without listening or replacing Store identity and credentials", async () => {
      const p = await payload();
      await cp(join(workerDirectory, "dist"), join(p.app, "dist"), {
        recursive: true,
      });
      expect(
        (await readFile(join(p.app, "dist", "bootstrap.js"), "utf8")).includes(
          "startWindowsWorker",
        ),
      ).toBe(true);
      const directory = join(p.root, "store");
      const initialized = initializeStore({ directory, clock: Date.now });
      const serviceId = initialized.store.identity.serviceId;
      const authorization = `Bearer ${initialized.credential.key}`;
      const principal = authenticate(initialized.store, authorization);
      initialized.store.close();
      const pfxPath = join(p.app, "missing-main-private.pfx");
      const port = await vacantPort();
      await writeFile(
        join(p.app, "worker.config.json"),
        JSON.stringify(
          configuration(
            directory,
            port,
            pfxPath,
            initialized.credential.clientId,
          ),
        ),
        { flag: "wx" },
      );
      const running = run(p);
      const listened = await Promise.race([
        running.line("enhancement_worker_listening").then(
          () => true,
          () => running.closed.then(() => false),
        ),
        running.closed.then(() => false),
      ]);
      expect(listened, "missing PFX never produces a usable runtime").toBe(
        false,
      );
      expect(await running.ended()).toEqual({ code: 2, signal: null });
      expect(running.stdout === "").toBe(true);
      expect(running.stderr === "enhancement_worker_start_failed\n").toBe(true);
      expect(isDeepStrictEqual(running.messages, [])).toBe(true);
      expect(running.stderr.includes(pfxPath)).toBe(false);
      const reopened = openStore({ directory, clock: Date.now });
      try {
        expect(reopened.identity.serviceId === serviceId).toBe(true);
        expect(
          isDeepStrictEqual(authenticate(reopened, authorization), principal),
        ).toBe(true);
      } finally {
        reopened.close();
      }
    }, 15_000);
  },
);
