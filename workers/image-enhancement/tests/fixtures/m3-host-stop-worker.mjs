import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// Business module composition only; this does not qualify production bootstrap/F01/GPU.
const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
assert(["original", "recover"].includes(config.phase));
assert(config.allowInterrupt === undefined || config.allowInterrupt === true);
const eventsPath = join(config.directory, "worker-" + config.phase + ".ndjson");
writeFileSync(eventsPath, "", { flag: "wx" });
function emit(kind, facts) {
  appendFileSync(eventsPath, JSON.stringify({ kind, ...facts }) + "\n");
}
for (const event of ["uncaughtException", "unhandledRejection"])
  process.on(event, () => {
    emit("fatal", { event });
    process.exit(2);
  });
const load = (name) => import(pathToFileURL(join(config.dist, name + ".js")).href);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const { createWorkerConfig } = await load("config");
const { createSystemClock } = await load("clock");
const { openStore } = await load("store");
const { createRunner } = await load("runner");
const { listenEnhancementServer } = await load("http");
const { createWindowsExecutionAdapter } = await load("windows-execution-adapter");
const bridge = {
  ...config.bridge,
  environment: Object.fromEntries(
    ["SystemRoot", "WINDIR", "PATH", "TEMP", "TMP", "COMSPEC", "PATHEXT", "DOTNET_ROOT"]
      .filter((key) => typeof process.env[key] === "string")
      .map((key) => [key, process.env[key]]),
  ),
};
const native = createWindowsExecutionAdapter({
  bridge,
  journalLimits: {
    maxRequestBytes: 4 * 1_048_576,
    maxStdoutBytes: 1_048_576,
    maxStderrBytes: 65_536,
    readTimeoutMs: config.runnerLimits.executionTimeoutMs,
    cleanupTimeoutMs: config.runnerLimits.cancelGraceMs,
  },
});
const calls = { prepare: 0, authorize: 0, inspect: 0 };
let lastAttempt = config.originalAttempt;
const executor = {
  ...native,
  async prepare(attempt, guard) {
    calls.prepare++;
    lastAttempt = attempt;
    const control = JSON.parse(readFileSync(config.engineControlBasePath, "utf8"));
    const expectedArgv = [...config.recipeTemplate];
    expectedArgv[1] = attempt.inputPath;
    expectedArgv[3] = attempt.outputPath;
    const input = readFileSync(attempt.inputPath);
    writeFileSync(join(attempt.workingDirectory, "engine-control.json"), JSON.stringify({
      ...control,
      marker: join(attempt.workingDirectory, "engine.marker"),
      expectedArgv,
      inputSha256: hash(input),
    }), { flag: "wx" });
    emit("prepare", { attempt, inputSha256: hash(input) });
    const descriptor = await native.prepare(attempt, guard);
    emit("prepared", { attempt, descriptor });
    return descriptor;
  },
  async authorize(attempt, descriptor, guard) {
    calls.authorize++;
    await native.authorize(attempt, descriptor, guard);
    emit("authorized", { attempt, descriptor, active: store.getActiveAttempt(attempt.identity) });
  },
  async inspect(target, descriptor) {
    calls.inspect++;
    const inspection = await native.inspect(target, descriptor);
    emit("inspection", { target, descriptor, inspection });
    return inspection;
  },
};
const clock = createSystemClock();
const store = openStore({
  directory: config.storeDirectory,
  clock: clock.now,
  interruptionEvidenceReader: native.readInterruptionEvidence,
});
const runner = createRunner({ store, clock, executor, ownerInstanceId: randomUUID() });
// This admission gate is fixture policy, not production readiness evidence.
const ready = () => {
  const status = runner.status();
  const activity = native.status();
  return !status.closed && !activity.sealed && status.recoveryState === "idle" &&
    !["unknown", "cleanup_unknown"].includes(activity.activity);
};
const server = await listenEnhancementServer({
  store,
  config: () => createWorkerConfig(config.workerConfig),
  submissionLimits: config.submissionLimits,
  runnerLimits: config.runnerLimits,
  transportLimits: config.transportLimits,
  ready,
  onJobCommitted: () => runner.wake(),
  // Real HTTP uses its default localInputFiles, including directory fsync.
}, 0);
const address = server.address();
assert(address && typeof address !== "string");
emit("listening", { port: address.port, node: process.version });
function snapshot(kind, extra = {}) {
  emit(kind, {
    calls: { ...calls },
    status: runner.status(),
    adapter: native.status(),
    counts: store.inspectMaintenance(),
    active: lastAttempt ? store.getActiveAttempt(lastAttempt.identity) ?? null : null,
    fixtureAdmission: ready(),
    productionBootstrapQualified: false,
    gpuVerified: false,
    ...extra,
  });
}
await runner.recover();
snapshot("recovered");
if (config.allowInterrupt === true) {
  const expected = Buffer.from("ZEB_FIXTURE_INTERRUPT_V1\n", "ascii");
  let received = Buffer.alloc(0), accepted = false;
  process.stdin.on("data", (chunk) => {
    assert(Buffer.isBuffer(chunk) && !accepted);
    assert(received.length + chunk.length <= expected.length);
    received = Buffer.concat([received, chunk]);
    if (received.length !== expected.length) return;
    assert(received.equals(expected));
    accepted = true;
    const beforeInterrupt = {
      active: lastAttempt ? store.getActiveAttempt(lastAttempt.identity) ?? null : null,
      counts: store.inspectMaintenance(),
      calls: { ...calls },
    };
    // interrupt fixes the original control-loss cause synchronously, before Runner abort.
    const pending = native.interrupt();
    void runner.close();
    void pending.then((cleanup) => snapshot("interrupted", { cleanup, beforeInterrupt }));
  });
}
setInterval(() => snapshot("state"), 100);
