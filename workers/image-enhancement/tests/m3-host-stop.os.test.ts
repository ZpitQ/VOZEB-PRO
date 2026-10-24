import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";

import Database from "better-sqlite3";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { initializeStore, type JobDto } from "../src/store.js";
import { createWindowsJournalLauncher } from "../src/windows-journal-launcher.js";
import type { ActiveAttempt, ClaimedAttempt, OwnerDescriptor } from "../src/execution.js";
import { configInput, planInput } from "./fixtures.js";
import { boundary, multipart, transportLimits, uploadParts } from "./http-fixtures.js";
import { runnerLimits, submissionLimits } from "./storage-fixtures.js";

type Pin = {
  identity: { pid: number; creationFileTime: string };
  originalRetained: boolean;
  originalJoined: boolean;
  alive: boolean;
  exitCode: number | null;
};
type Frame = {
  kind: string;
  passed?: boolean;
  guardianUsed?: boolean;
  explicitStop?: boolean;
  root?: { pid: number; creationFileTime: string };
  cleanup?: { treeExit: { activeProcesses: number }; stdout: { eof: boolean }; stderr: { eof: boolean } };
  allPinsJoined?: boolean;
  engineObserved?: number;
  interruptSent?: boolean;
  beforeInterrupt?: { pins: Pin[]; census: { activeProcesses: number; memberIds: number[] } };
  beforeStop?: { pins: Pin[] };
  pins?: Pin[];
};
type WorkerEvent = {
  kind: string;
  port: number;
  node: string;
  attempt: ClaimedAttempt;
  descriptor: OwnerDescriptor;
  active: ActiveAttempt;
  calls: { prepare: number; authorize: number; inspect: number };
  status: { recoveryState: string; closed: boolean };
  counts: { slots: number; running: number };
  productionBootstrapQualified: boolean;
  cleanup?: "closed" | "unknown";
  beforeInterrupt?: { active: ActiveAttempt; calls: WorkerEvent["calls"] };
};
const suite = process.env.ZEB_M3_HOST_STOP_OS_TESTS === "1" ? describe : describe.skip;
const duration = runnerLimits.executionTimeoutMs;
const cleanup = runnerLimits.cancelGraceMs;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function until<T>(read: () => Promise<T | undefined>, milliseconds = duration): Promise<T> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await pause(10);
  }
  throw new Error("Fixture observation deadline expired; no operation is replayed.");
}
function start(executable: string, args: string[], cwd: string) {
  const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, stdio: "pipe" });
  const output: Buffer[] = [], error: Buffer[] = [], failures: string[] = [];
  let stdoutEof = false, stderrEof = false, guardianUsed = false, bytes = 0;
  let secondGuard: ReturnType<typeof setTimeout> | undefined;
  child.once("error", (failure) => failures.push(failure.name));
  for (const stream of [child.stdin, child.stdout, child.stderr])
    stream.once("error", (failure) => failures.push(failure.name));
  for (const [stream, chunks] of [[child.stdout, output], [child.stderr, error]] as const)
    stream.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= 4 * 1_048_576) chunks.push(Buffer.from(chunk));
      else { failures.push("capture-overflow"); child.kill(); }
    });
  child.stdout.once("end", () => { stdoutEof = true; });
  child.stderr.once("end", () => { stderrEof = true; });
  let resolveClose!: (value: { code: number | null; signal: string | null }) => void;
  let rejectClose!: (error: Error) => void;
  const closed = new Promise<{ code: number | null; signal: string | null }>((done, reject) => {
    resolveClose = done;
    rejectClose = reject;
  });
  void closed.catch(() => {});
  const guard = setTimeout(() => {
    guardianUsed = true;
    child.kill(); // The retained fixture process owns its KILL_ON_JOB_CLOSE tree.
    secondGuard = setTimeout(() => rejectClose(new Error("Original fixture close was not joined.")), cleanup);
  }, duration + cleanup);
  child.once("close", (code, signal) => {
    clearTimeout(guard);
    if (secondGuard) clearTimeout(secondGuard);
    resolveClose({ code, signal });
  });
  const frames = () => Buffer.concat(output).toString("utf8").split("\n")
    .filter(Boolean).flatMap((line) => { try { return [JSON.parse(line) as Frame]; } catch { return []; } });
  return {
    child, closed, frames,
    send(value: unknown) { child.stdin.write(JSON.stringify(value) + "\n"); },
    result() { return { failures, stdoutEof, stderrEof, guardianUsed, stderr: Buffer.concat(error).toString("base64") }; },
  };
}
async function events(directory: string, phase: string): Promise<WorkerEvent[]> {
  try {
    const text = await readFile(join(directory, "worker-" + phase + ".ndjson"), "utf8");
    const records = text.split("\n").slice(0, -1).filter(Boolean).map((line) => JSON.parse(line) as WorkerEvent);
    if (records.some((record) => record.kind === "fatal")) throw new Error("Actual fixture worker exited with a recorded failure.");
    return records;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
async function rawRecords(root: string) {
  const entries = await readdir(root, { withFileTypes: true });
  return Promise.all(entries.sort((a, b) => a.name.localeCompare(b.name)).map(async (entry) => {
    expect(entry.isFile()).toBe(true);
    expect(entry.isSymbolicLink()).toBe(false);
    const bytes = await readFile(join(root, entry.name));
    return { name: entry.name, sha256: digest(bytes), bytesBase64: bytes.toString("base64") };
  }));
}

function coldSidecar(suffix: string, bytes: Buffer): boolean {
  // SQLite ignores a zeroed rollback header; this stricter fixture gate still rejects WAL and short headers.
  return bytes.length === 0 || (suffix === "-journal" && bytes.length >= 512 &&
    bytes.subarray(0, 512).every((byte) => byte === 0));
}
async function coldSidecars(directory: string) {
  return Promise.all(["-journal", "-wal"].map(async (suffix) => {
    try {
      const bytes = await readFile(join(directory, "worker.sqlite" + suffix));
      expect(coldSidecar(suffix, bytes)).toBe(true);
      return { suffix, byteLength: bytes.length, sha256: digest(bytes) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { suffix, byteLength: null, sha256: null };
    }
  }));
}
describe("M3 stopped SQLite fixture snapshot", () => {
  it("rejects hot journals and nonempty WAL while accepting an unchanged zero-header rollback journal", () => {
    const cold = Buffer.alloc(1024, 7);
    cold.fill(0, 0, 512);
    const hot = Buffer.from(cold);
    Buffer.from("d9d505f920a163d7", "hex").copy(hot);
    expect(coldSidecar("-journal", hot)).toBe(false);
    expect(coldSidecar("-journal", Buffer.alloc(511))).toBe(false);
    expect(coldSidecar("-wal", cold)).toBe(false);
    expect(coldSidecar("-journal", cold)).toBe(true);
    expect(coldSidecar("-wal", Buffer.alloc(0))).toBe(true);
  });
});

suite.sequential("M3 actual Host Stop with persisted business queue", () => {
  async function exercise(mode: "force" | "interrupt") {
    expect(process.platform).toBe("win32");
    const required = ["ZEB_M3_HOST_STOP_NODE_EXE", "ZEB_WINDOWS_SERVICE_HOST_FIXTURE_EXE",
      "ZEB_WINDOWS_CONTROL_BRIDGE_SESSION_FIXTURE_EXE", "ZEB_WINDOWS_CONTROL_BRIDGE_EXE",
      "ZEB_WINDOWS_CONTROL_BRIDGE_ORDINARY_EXE"] as const;
    const paths = required.map((key) => {
      const value = process.env[key];
      if (!value || !isAbsolute(value)) throw new Error("Explicit absolute fixture path required: " + key);
      return value;
    });
    const [node, hostExe, sessionExe, bridgeExe, helperExe] = paths;
    const main = resolve(import.meta.dirname, "fixtures/m3-host-stop-worker.mjs");
    const dist = resolve(import.meta.dirname, "../dist");
    for (const path of [...paths, main, join(dist, "bootstrap.js"), join(dist, "runner.js")]) await access(path);
    const moduleNames = ["config", "clock", "runner", "http", "store", "jobs", "credentials",
      "execution", "artifacts", "windows-execution-adapter", "windows-control-bridge-host",
      "windows-control-bridge-protocol", "windows-journal-launcher", "windows-journal-reader",
      "windows-prepare-payload", "image-io"];
    const artifacts = async () => Promise.all([...paths, main, ...moduleNames.map((name) => join(dist, name + ".js")),
      join(dirname(hostExe!), "WindowsServiceHostFixture.dll"), join(dirname(hostExe!), "WindowsServiceHost.dll"),
      join(dirname(hostExe!), "WindowsSupervisor.dll"),
      join(dirname(sessionExe!), "WindowsSessionFixture.dll"), join(dirname(bridgeExe!), "WindowsControlBridge.dll"),
      join(dirname(helperExe!), "WindowsSupervisor.dll")].map(async (path) =>
      ({ path, sha256: digest(await readFile(path)) })));
    const before = await artifacts();
    const directory = await mkdtemp(join(process.env.ZEB_M3_HOST_STOP_EVIDENCE_DIR ?? tmpdir(), "m3-host-stop-"));
    const setup = start(sessionExe!, ["png-bundle", directory], directory);
    setup.child.stdin.end();
    expect(await setup.closed).toEqual({ code: 0, signal: null });
    expect(setup.result()).toEqual({ failures: [], stdoutEof: true, stderrEof: true, guardianUsed: false, stderr: "" });
    const bundle = setup.frames()[0] as unknown as {
      root: string; manifestSha256: string; recipeTemplate: string[];
      selection: { modelId: string; binaryVersion: string; binarySha256: string; modelVersion: string; modelSha256: string };
    };
    const storeDirectory = join(directory, "data"), recordsRoot = join(directory, "records");
    const initialized = initializeStore({ directory: storeDirectory, clock: Date.now });
    const key = initialized.credential.key; // Memory only; never include in evidence/config.
    initialized.store.close();
    const workerConfig = configInput();
    workerConfig.models = [{
      ...workerConfig.models[0]!, id: bundle.selection.modelId,
      binaryVersion: bundle.selection.binaryVersion, binarySha256: bundle.selection.binarySha256,
      modelVersion: bundle.selection.modelVersion, modelSha256: bundle.selection.modelSha256,
      allowedTiles: [32], defaultTile: 32,
    }];
    const base = {
      directory, dist, storeDirectory, workerConfig, runnerLimits, submissionLimits, transportLimits,
      ...(mode === "interrupt" ? { allowInterrupt: true } : {}),
      engineBinaryPath: join(bundle.root, "bin/upscayl-bin.exe"), recipeTemplate: bundle.recipeTemplate,
      bridge: {
        executablePath: bridgeExe, helperPath: helperExe, recordsRoot, installationRoot: bundle.root,
        expectedManifestSha256: bundle.manifestSha256,
        limits: { maxRequestFrameBytes: 65_536, maxResponseFrameBytes: 65_536, maxHelperStderrBytes: 65_536,
          maxSessionInputBytes: 4 * 1_048_576, maxSessionOutputBytes: 4 * 1_048_576, maxQueuedOutputBytes: 262_144,
          maxJsonDepth: 32, startupTimeoutMs: 5_000, requestTimeoutMs: 5_000,
          sessionTimeoutMs: duration + 2 * cleanup, cleanupTimeoutMs: cleanup },
      },
    };
    const hosts: { handle: ReturnType<typeof start>; root?: Frame["root"]; stopped: boolean }[] = [];
    async function launch(phase: string, originalAttempt?: ClaimedAttempt) {
      const configPath = join(directory, "config-" + phase + ".json");
      await writeFile(configPath, JSON.stringify({
        ...base, phase, originalAttempt, engineControlBasePath: join(directory, "engine-base-" + phase + ".json"),
      }), { flag: "wx" });
      const handle = start(hostExe!, ["worker-stop", node!, main, configPath, directory, String(duration), String(cleanup)], directory);
      const host = { handle, root: undefined as Frame["root"], stopped: false };
      hosts.push(host);
      handle.send({ kind: "start" });
      host.root = (await until(async () => handle.frames().find((frame) => frame.kind === "host-start"))).root;
      expect(host.root).toBeDefined();
      return host;
    }
    async function stop(host: typeof hosts[number], descriptor?: OwnerDescriptor) {
      host.stopped = true;
      host.handle.send({ kind: "stop", root: host.root,
        engine: descriptor?.details.engine ?? null, supervisor: descriptor?.details.supervisor ?? null });
      host.handle.child.stdin.end();
      expect(await host.handle.closed).toEqual({ code: 0, signal: null });
      expect(host.handle.result()).toEqual({ failures: [], stdoutEof: true, stderrEof: true, guardianUsed: false, stderr: "" });
      const receipt = host.handle.frames().find((frame) => frame.kind === "host-completed")!;
      expect(receipt).toMatchObject({ passed: true, explicitStop: true, guardianUsed: false, allPinsJoined: true,
        cleanup: { treeExit: { activeProcesses: 0 }, stdout: { eof: true }, stderr: { eof: true } } });
      return receipt;
    }
    const call = async (port: number, path: string, body?: Buffer, idempotencyKey?: string) => {
      const response = await fetch("http://127.0.0.1:" + port + path, {
        method: body ? "POST" : "GET", signal: AbortSignal.timeout(cleanup),
        headers: { authorization: "Bearer " + key, ...(body ? {
          "content-type": "multipart/form-data; boundary=" + boundary, "idempotency-key": idempotencyKey!,
        } : {}) }, ...(body ? { body: new Uint8Array(body) } : {}),
      });
      const json = await response.json() as { data: { job: JobDto; ready: boolean } };
      expect(response.ok).toBe(true);
      return json.data;
    };
    try {
      const first = await launch("original");
      const listening = await until(async () => (await events(directory, "original")).find((event) => event.kind === "listening"));
      expect(listening.node).toMatch(/^v22\./);
      await until(async () => (await events(directory, "original")).find((event) => event.kind === "recovered"));
      const source = await sharp({ create: { width: 4, height: 3, channels: 3, background: "red" } }).png().toBuffer();
      const plan = { ...planInput(digest(source)), modelId: bundle.selection.modelId, tile: 32 };
      const body = multipart(uploadParts(source, { filename: "source.png", type: "image/png" }, plan));
      const a = (await call(listening.port, "/v1/enhancement-jobs", body, "m3-host-stop-a")).job;
      const authorized = await until(async () => (await events(directory, "original")).find((event) => event.kind === "authorized"));
      expect(authorized.attempt.job.jobId).toBe(a.jobId);
      const marker = join(authorized.attempt.workingDirectory, "engine.marker");
      await until(async () => {
        try { return JSON.parse(await readFile(marker, "utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
      });
      expect(JSON.parse(await readFile(marker, "utf8"))).toEqual(authorized.descriptor.details.engine);
      const b = (await call(listening.port, "/v1/enhancement-jobs", body, "m3-host-stop-b")).job;
      expect(b.status).toBe("queued");
      const liveA = (await call(listening.port, "/v1/enhancement-jobs/" + a.jobId)).job;
      expect(liveA.status).toBe("running");
      if (mode === "interrupt") {
        first.handle.send({ kind: "interrupt", root: first.root,
          engine: authorized.descriptor.details.engine, supervisor: authorized.descriptor.details.supervisor });
        const sent = await until(async () => first.handle.frames().find((frame) => frame.kind === "host-interrupt-sent"));
        expect(sent.interruptSent).toBe(true);
        const beforePins = sent.beforeInterrupt!.pins;
        expect(beforePins).toHaveLength(3);
        expect(beforePins.map((pin) => pin.identity)).toEqual([
          first.root, authorized.descriptor.details.engine, authorized.descriptor.details.supervisor,
        ]);
        for (const pin of beforePins)
          expect(pin).toMatchObject({ alive: true, originalRetained: true, originalJoined: false, exitCode: null });
        const interrupted = await until(async () => (await events(directory, "original"))
          .find((event) => event.kind === "interrupted"));
        expect(interrupted.cleanup).toBe("closed");
        expect(interrupted.status.closed).toBe(true);
        expect(interrupted.counts).toMatchObject({ slots: 1, running: 1 });
        expect(interrupted.beforeInterrupt!.active.identity).toEqual(authorized.attempt.identity);
        expect(interrupted.beforeInterrupt!.active.ownerDescriptor).toEqual(authorized.descriptor);
        expect(interrupted.active).toEqual(interrupted.beforeInterrupt!.active);
        expect(interrupted.calls).toEqual(interrupted.beforeInterrupt!.calls);
        expect(interrupted.calls).toMatchObject({ prepare: 1, authorize: 1 });
        expect((await call(listening.port, "/v1/capabilities")).ready).toBe(false); // Fixture admission only.
        const aAfter = (await call(listening.port, "/v1/enhancement-jobs/" + a.jobId)).job;
        const bAfter = (await call(listening.port, "/v1/enhancement-jobs/" + b.jobId)).job;
        expect(aAfter).toEqual(liveA);
        expect({ source: bAfter.source, plan: bAfter.plan, createdAt: bAfter.createdAt, queueDeadlineAt: bAfter.queueDeadlineAt })
          .toEqual({ source: b.source, plan: b.plan, createdAt: b.createdAt, queueDeadlineAt: b.queueDeadlineAt });
        expect(bAfter.status === "queued" || (bAfter.status === "failed" && bAfter.reason === "queue_timeout" &&
          Date.now() > b.queueDeadlineAt)).toBe(true);
        const raw = await rawRecords(recordsRoot);
        for (const id of ["1", "2", "3", "5", "6"])
          expect(raw.some((entry) => entry.name.endsWith(".record-" + "0".repeat(31) + id + ".json"))).toBe(true);
        const reader = createWindowsJournalLauncher({
          executablePath: helperExe!, recordsRoot,
          environment: Object.fromEntries(
            ["SystemRoot", "WINDIR", "PATH", "TEMP", "TMP", "COMSPEC", "PATHEXT", "DOTNET_ROOT"]
              .filter((name) => typeof process.env[name] === "string")
              .map((name) => [name, process.env[name]!])),
          limits: { maxRequestBytes: 4 * 1_048_576, maxStdoutBytes: 1_048_576, maxStderrBytes: 65_536,
            readTimeoutMs: duration, cleanupTimeoutMs: cleanup },
        });
        let strict;
        try {
          strict = await reader.read({
            target: { identity: authorized.attempt.identity, launchTicket: authorized.attempt.launchTicket },
            executionPolicyFingerprint: authorized.attempt.executionPolicy.fingerprint,
          }, authorized.descriptor, AbortSignal.timeout(duration), () => true);
          expect(strict).toMatchObject({ kind: "read", interpretation: { kind: "interrupted" }, cleanup: "closed" });
          if (strict.kind !== "read" || strict.interpretation.kind !== "interrupted")
            throw new Error("Original native interrupted evidence was not strictly verified.");
          expect(strict.interpretation.exit).toMatchObject({
            identity: authorized.attempt.identity, launchTicket: authorized.attempt.launchTicket,
            descriptor: authorized.descriptor, treeExited: true, completion: { kind: "interrupted" },
          });
        } finally {
          expect(await reader.close()).toBe("closed");
        }
        await writeFile(join(directory, "raw-after-interrupt.json"), JSON.stringify(raw), { flag: "wx" });
        const receipt = await stop(first); // Same original Node/Host, only after the independent native proof.
        expect(receipt.interruptSent).toBe(true);
        expect(receipt.beforeInterrupt).toEqual(sent.beforeInterrupt);
        expect(receipt.beforeStop!.pins.map((pin) => pin.identity)).toEqual(beforePins.map((pin) => pin.identity));
        expect(receipt.beforeStop!.pins[0]!.alive).toBe(true);
        for (const pin of receipt.beforeStop!.pins.slice(1))
          expect(pin).toMatchObject({ alive: false, originalRetained: true, originalJoined: false });
        expect(receipt.pins!.map((pin) => pin.identity)).toEqual(beforePins.map((pin) => pin.identity));
        for (const pin of receipt.pins!)
          expect(pin).toMatchObject({ alive: false, originalRetained: true, originalJoined: true });
        expect(await rawRecords(recordsRoot)).toEqual(raw);
        for (const job of [a, b]) {
          const input = join(storeDirectory, "inputs", job.jobId);
          expect(await readFile(join(input, "original.png"))).toEqual(source);
          expect(digest(await readFile(join(input, "engine.png")))).toBe(job.engineInput.sha256);
        }
        // Only inspect this known-stopped exclusive fixture; never recover or remove original sidecars.
        const sidecars = await coldSidecars(storeDirectory);
        const databaseBytes = await readFile(join(storeDirectory, "worker.sqlite"));
        const db = new Database(databaseBytes);
        let persisted;
        try {
          persisted = {
            jobs: db.prepare("SELECT job_id,status FROM jobs ORDER BY job_id").all(),
            slot: db.prepare("SELECT job_id,attempt_no,fence FROM execution_slot").all(),
            attempts: db.prepare("SELECT job_id,attempt_no,owner_instance_id,fence,launch_ticket,lease_expires_at FROM attempts").all(),
          };
          expect(persisted.jobs).toEqual([{ job_id: a.jobId, status: aAfter.status }, { job_id: b.jobId, status: bAfter.status }]
            .sort((left, right) => left.job_id.localeCompare(right.job_id)));
          expect(persisted.slot).toEqual([{ job_id: a.jobId, attempt_no: authorized.attempt.identity.attemptNo,
            fence: authorized.attempt.identity.fence }]);
          expect(persisted.attempts).toEqual([{ job_id: a.jobId, attempt_no: authorized.attempt.identity.attemptNo,
            owner_instance_id: authorized.attempt.identity.ownerInstanceId, fence: authorized.attempt.identity.fence,
            launch_ticket: authorized.attempt.launchTicket, lease_expires_at: interrupted.active.leaseExpiresAt }]);
        } finally { db.close(); }
        expect(await readFile(join(storeDirectory, "worker.sqlite"))).toEqual(databaseBytes);
        expect(await coldSidecars(storeDirectory)).toEqual(sidecars);
        expect(await artifacts()).toEqual(before);
        await writeFile(join(directory, "m3-adapter-interrupt-result.json"), JSON.stringify({
          interruptedNativeSealVerified: true, runningAutomaticRecovery: false, replacementStarted: false,
          productionBootstrapQualified: false, gpuVerified: false, finalized: false,
          accepted: { a, b }, beforeDTO: { a: liveA, b }, afterDTO: { a: aAfter, b: bAfter },
          interrupted, strict, raw, receipt, persisted, sidecars, databaseSha256: digest(databaseBytes), artifacts: before,
        }), { flag: "wx" });
        process.stdout.write("[M3-ADAPTER-INTERRUPT] " + JSON.stringify({
          directory, interruptedNativeSealVerified: true, replacementStarted: false,
        }) + "\n");
        return;
      }
      const firstReceipt = await stop(first, authorized.descriptor);
      expect(firstReceipt.engineObserved).toBe(1);
      const raw = await rawRecords(recordsRoot);
      await writeFile(join(directory, "raw-after-original.json"), JSON.stringify(raw), { flag: "wx" });
      const terminalExists = raw.some((entry) => entry.name.endsWith(".record-" + "0".repeat(31) + "6.json"));
      if (terminalExists) {
        await writeFile(join(directory, "cut-not-missing-terminal.json"), JSON.stringify({
          classification: "actual-terminal-present", runningUnknownBranchTriggered: false, descriptor: authorized.descriptor,
        }), { flag: "wx" });
        throw new Error("Actual terminal exists: preserve/classify it; missing-terminal branch was not triggered.");
      }
      for (const id of ["1", "2", "3"])
        expect(raw.some((entry) => entry.name.endsWith(".record-" + "0".repeat(31) + id + ".json"))).toBe(true);
      const reader = createWindowsJournalLauncher({
        executablePath: helperExe!, recordsRoot,
        environment: Object.fromEntries(
          ["SystemRoot", "WINDIR", "PATH", "TEMP", "TMP", "COMSPEC", "PATHEXT", "DOTNET_ROOT"]
            .filter((name) => typeof process.env[name] === "string")
            .map((name) => [name, process.env[name]!])),
        limits: { maxRequestBytes: 4 * 1_048_576, maxStdoutBytes: 1_048_576, maxStderrBytes: 65_536,
          readTimeoutMs: duration, cleanupTimeoutMs: cleanup },
      });
      try {
        expect(await reader.read({
          target: { identity: authorized.attempt.identity, launchTicket: authorized.attempt.launchTicket },
          executionPolicyFingerprint: authorized.attempt.executionPolicy.fingerprint,
        }, authorized.descriptor, AbortSignal.timeout(duration), () => true))
          .toEqual({ kind: "read", interpretation: { kind: "unknown" }, cleanup: "closed" });
      } finally {
        expect(await reader.close()).toBe("closed");
      }
      const originals = await Promise.all([a, b].map(async (job) => {
        const input = join(storeDirectory, "inputs", job.jobId);
        expect(await readFile(join(input, "original.png"))).toEqual(source);
        expect(digest(await readFile(join(input, "engine.png")))).toBe(job.engineInput.sha256);
        return { jobId: job.jobId, sourceSha256: job.source.sha256, engineSha256: job.engineInput.sha256, plan: job.plan };
      }));
      const second = await launch("recover", authorized.attempt);
      const recovering = await until(async () => (await events(directory, "recover")).find((event) => event.kind === "recovered"));
      expect(recovering.status.recoveryState).toBe("unknown");
      expect(recovering.counts).toMatchObject({ slots: 1, running: 1 });
      expect(recovering.calls).toMatchObject({ prepare: 0, authorize: 0 });
      expect(recovering.calls.inspect).toBeGreaterThan(0);
      expect(recovering.active.identity).toEqual(authorized.attempt.identity);
      expect(recovering.active.launchTicket).toBe(authorized.attempt.launchTicket);
      expect(recovering.active.ownerDescriptor).toEqual(authorized.descriptor);
      expect(recovering.productionBootstrapQualified).toBe(false);
      const listening2 = (await events(directory, "recover")).find((event) => event.kind === "listening")!;
      expect((await call(listening2.port, "/v1/capabilities")).ready).toBe(false); // Fixture gate only.
      expect((await call(listening2.port, "/v1/enhancement-jobs/" + a.jobId)).job).toEqual(liveA);
      const bAfter = (await call(listening2.port, "/v1/enhancement-jobs/" + b.jobId)).job;
      expect({ source: bAfter.source, plan: bAfter.plan, createdAt: bAfter.createdAt, queueDeadlineAt: bAfter.queueDeadlineAt })
        .toEqual({ source: b.source, plan: b.plan, createdAt: b.createdAt, queueDeadlineAt: b.queueDeadlineAt });
      expect(bAfter.status === "queued" || (bAfter.status === "failed" && bAfter.reason === "queue_timeout" &&
        Date.now() > b.queueDeadlineAt)).toBe(true);
      const secondReceipt = await stop(second);
      expect(secondReceipt.engineObserved).toBe(0);
      expect(await rawRecords(recordsRoot)).toEqual(raw);
      for (const original of originals) {
        const input = join(storeDirectory, "inputs", original.jobId);
        expect(digest(await readFile(join(input, "original.png")))).toBe(original.sourceSha256);
        expect(digest(await readFile(join(input, "engine.png")))).toBe(original.engineSha256);
      }
      expect(await artifacts()).toEqual(before);
      await writeFile(join(directory, "m3-host-stop-result.json"), JSON.stringify({
        missingTerminalUnknownProtection: true, runningAutomaticRecovery: false,
        productionBootstrapQualified: false, gpuVerified: false, finalized: false,
        originals, firstReceipt, secondReceipt, recovery: recovering, artifacts: before,
      }), { flag: "wx" });
      process.stdout.write("[M3-HOST-STOP] " + JSON.stringify({ directory, missingTerminalUnknownProtection: true }) + "\n");
    } finally {
      for (const host of hosts.reverse()) {
        if (!host.stopped) {
          host.handle.send({ kind: "cleanup", root: host.root ?? null });
          host.handle.child.stdin.end();
        }
        await host.handle.closed;
      }
    }
  }
  it("keeps the original occupied slot Unknown when actual Force leaves no trusted terminal",
    () => exercise("force"), 3 * (duration + 2 * cleanup));
  it("interrupt preserves actual native loss and terminal before the original Host cleanup",
    () => exercise("interrupt"), 3 * (duration + 2 * cleanup));
});
