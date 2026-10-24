import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const controller = new AbortController();
let runtime;
let exiting = false;
let startupObservation, startupWrite;
let bootstrapEntered = false, startupWriteFailed = false;
const shutdownFrame = Buffer.from("ZEB_WORKER_SHUTDOWN_V1\n", "ascii");
let frameOffset = 0;
let shutdownPromise, settleShutdown, shutdownTimer;
let shutdownDeadlineAt = 0;
let shutdownInvoked = false, shutdownUnknown = false, shutdownVerified = false;

function exit(code, event) {
  if (exiting) return;
  if (code === 0 && startupWriteFailed) code = 2;
  if (code === 0 && shutdownPromise && !shutdownVerified) code = 2;
  exiting = true;
  try {
    controller.abort();
  } finally {
    try {
      runtime?.close();
    } finally {
      try {
        if (event) process.stderr.write(`${event}\n`);
      } finally {
        process.exit(code);
      }
    }
  }
}

function writeStartup(observation) {
  if (startupWrite) return startupWrite;
  startupWrite = new Promise((resolve, reject) => {
    const deadline = performance.now() + 1_000;
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error || performance.now() >= deadline) {
        startupWriteFailed = true;
        reject(new Error("startup observation unavailable"));
      } else resolve();
    };
    const timer = setTimeout(() => finish(true), 1_000);
    try {
      const facts = {};
      for (const key of ["runnerConstructed", "listenerSucceeded", "recoveryCalled",
        "claimEntered", "prepareEntered", "authorizeEntered"]) {
        if (typeof observation?.[key] !== "boolean") throw new Error("invalid startup facts");
        facts[key] = observation[key];
      }
      if (!["listening", "listener_bind_failed", "store_schema_incompatible", "unknown"].includes(observation.phase) ||
          facts.recoveryCalled || facts.claimEntered || facts.prepareEntered || facts.authorizeEntered)
        throw new Error("invalid startup cut");
      const frame = "ZEB_WORKER_STARTUP_V1 " + JSON.stringify({
        v: 1, kind: "startup_phase", attempt: startupObservation.attempt,
        nonce: startupObservation.nonce, phase: observation.phase, ...facts,
      }) + "\n";
      if (Buffer.byteLength(frame, "utf8") > 512) throw new Error("startup frame too large");
      process.stderr.write(frame, finish);
    } catch { finish(true); }
  });
  return startupWrite;
}

process.on("SIGINT", () => exit(0));
process.on("SIGTERM", () => exit(0));
process.on("uncaughtException", () => exit(2, "enhancement_worker_failed"));
process.on("unhandledRejection", () => exit(2, "enhancement_worker_failed"));

function unknownShutdown() {
  if (shutdownUnknown || exiting) return;
  shutdownUnknown = true;
  process.exitCode = 2;
  clearTimeout(shutdownTimer);
  settleShutdown?.("unknown");
  try { process.stderr.write("enhancement_worker_shutdown_unknown\n"); } catch {}
}

function shutdownRuntime() {
  if (!shutdownPromise || !runtime || shutdownInvoked || exiting) return;
  shutdownInvoked = true;
  if (performance.now() >= shutdownDeadlineAt) unknownShutdown();
  let pending;
  try { pending = runtime.shutdown(shutdownDeadlineAt); }
  catch { unknownShutdown(); return; }
  void Promise.resolve(pending).then((outcome) => {
    if (outcome !== "closed" || shutdownUnknown || performance.now() >= shutdownDeadlineAt) {
      unknownShutdown();
      return;
    }
    shutdownVerified = true;
    clearTimeout(shutdownTimer);
    settleShutdown("closed");
    exit(0);
  }, unknownShutdown);
}

function requestShutdown() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = new Promise((resolve) => { settleShutdown = resolve; });
  process.exitCode = 2;
  shutdownDeadlineAt = performance.now() + 25_000;
  shutdownTimer = setTimeout(unknownShutdown, 25_000);
  shutdownRuntime();
  return shutdownPromise;
}

const controlFailed = () => exit(2, "enhancement_worker_control_failed");
process.stdin.on("data", (bytes) => {
  if (!Buffer.isBuffer(bytes)) return controlFailed();
  for (const byte of bytes) {
    if (byte !== shutdownFrame[frameOffset]) return controlFailed();
    if (++frameOffset === shutdownFrame.length) {
      frameOffset = 0;
      requestShutdown();
    }
  }
});
process.stdin.on("end", controlFailed);
process.stdin.on("error", controlFailed);
process.stdin.on("close", controlFailed);
process.stdin.resume();

try {
  if (process.argv.length === 3) {
    const match = /^--startup-observation-v1=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([0-9a-f]{64})$/.exec(process.argv[2]);
    if (!match || match[0] !== process.argv[2]) throw new Error("invalid worker arguments");
    startupObservation = Object.freeze({ attempt: match[1], nonce: match[2] });
  } else if (process.argv.length !== 2) throw new Error("invalid worker arguments");
  const configuration = JSON.parse(
    await readFile(new URL("./worker.config.json", import.meta.url), "utf8"),
  );
  if (
    !configuration ||
    !Number.isSafeInteger(configuration.port) ||
    configuration.port < 1 ||
    configuration.port > 65_535
  )
    throw new Error("invalid worker port");
  const { startWindowsWorker } = await import("./dist/bootstrap.js");
  if (!shutdownPromise) {
    bootstrapEntered = true;
    runtime = await startWindowsWorker(configuration, {
      appDirectory: dirname(fileURLToPath(import.meta.url)),
      signal: controller.signal,
      ...(startupObservation ? { onStartupObservation: writeStartup } : {}),
    });
    if (startupObservation) {
      if (!startupWrite) throw new Error("startup observation missing");
      await startupWrite;
    }
    if (shutdownPromise) shutdownRuntime();
    else process.stdout.write("enhancement_worker_listening\n");
  }
} catch {
  // Before bootstrap is entered, no Runner or execution path can have run.
  if (startupObservation && !startupWrite && !bootstrapEntered) {
    try {
      await writeStartup({
        phase: "unknown", runnerConstructed: false, listenerSucceeded: false,
        recoveryCalled: false, claimEntered: false, prepareEntered: false, authorizeEntered: false,
      });
    } catch {}
  }
  exit(2, "enhancement_worker_start_failed");
}
