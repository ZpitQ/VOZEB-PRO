import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

// Actual bootstrap/Store/Runner/Adapter/HTTP composition inside the existing guardian; no SCM or GPU qualification.
export async function runWorkerDiagnostic({ config, emit, facts, originalClosed, controller }) {
  const input = JSON.parse(await readFile(config.workerInputPath, "utf8"));
  const root = dirname(config.workerInputPath), payload = join(root, "worker-payload"), app = join(payload, "app");
  await mkdir(app, { recursive: true });
  await cp(dirname(config.options.executablePath), join(payload, "native", "bridge"), { recursive: true, errorOnExist: true, force: false });
  await cp(dirname(config.options.helperPath), join(payload, "native", "supervisor"), { recursive: true, errorOnExist: true, force: false });
  await cp(input.calibrationRoot, join(app, "resources", "calibration"), { recursive: true, errorOnExist: true, force: false });
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const nativeFiles = [];
  for (const [role, source, names] of [
    ["bridge", dirname(config.options.executablePath), ["WindowsControlBridge.exe", "WindowsControlBridge.dll", "WindowsSupervisor.dll"]],
    ["supervisor", dirname(config.options.helperPath), ["WindowsSupervisor.exe", "WindowsSupervisor.dll"]],
  ]) for (const name of names) {
    const original = hash(await readFile(join(source, name))), copied = hash(await readFile(join(payload, "native", role, name)));
    assert.equal(copied, original);
    nativeFiles.push({ role, name, sha256: copied });
  }
  const load = (name) => import(pathToFileURL(join(dirname(config.hostModule), name + ".js")).href);
  const { initializeStore } = await load("store");
  const { startWindowsWorker } = await load("bootstrap");
  const storeDirectory = join(root, "worker-store");
  const initialized = initializeStore({ directory: storeDirectory, clock: Date.now });
  const credential = initialized.credential;
  initialized.store.close();
  const runtime = await startWindowsWorker({
    storeDirectory, host: "127.0.0.1", port: 0, operatorClientId: credential.clientId,
    selfTestModelId: input.workerConfig.models[0].id,
    workerConfig: input.workerConfig, runnerLimits: input.runnerLimits,
    submissionLimits: input.submissionLimits, transportLimits: input.transportLimits,
    execution: { installationRoot: config.options.installationRoot, recordsRoot: config.options.recordsRoot,
      expectedManifestSha256: config.options.expectedManifestSha256,
      bridgeLimits: { ...config.options.limits, sessionTimeoutMs: 70_000 },
      journalLimits: { maxRequestBytes: 4 * 1_048_576, maxStdoutBytes: 1_048_576, maxStderrBytes: 65_536,
        readTimeoutMs: 60_000, cleanupTimeoutMs: 5_000 } },
  }, { appDirectory: app, signal: controller.signal });
  const address = runtime.server.address();
  assert(address && typeof address !== "string");
  const calls = [];
  const call = async (method, path, authorized = true) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method,
      headers: { authorization: "Bearer " + (authorized ? credential.key : "INERT_INVALID_CREDENTIAL") },
      signal: AbortSignal.timeout(5_000) });
    const body = await response.json();
    calls.push({ method, path, status: response.status });
    return { status: response.status, body };
  };
  const until = async (predicate) => {
    const cutoff = performance.now() + 20_000;
    while (!predicate()) {
      assert(performance.now() < cutoff, "worker diagnostic observation expired");
      await delay(20);
    }
  };
  await until(() => runtime.status().startupRecovery === "settled");
  const unauthorized = await call("GET", "/v1/maintenance", false);
  assert.equal(unauthorized.status, 401);
  const calibration = join(app, "resources", "calibration", "zeb-enhancement-calibration-v1", "calibration.png");
  const calibrationBefore = hash(await readFile(calibration));
  const submitted = await call("POST", "/v1/self-test");
  assert.equal(submitted.status, 202);
  await until(() => runtime.status().runner.ownedState === "unknown");
  const commands = facts.input.map((raw) => JSON.parse(Buffer.from(raw, "base64").toString("utf8")));
  const prepares = commands.filter((value) => value.kind === "command" && value.op === "prepare");
  assert.equal(prepares.length, 1);
  assert.equal(commands.filter((value) => value.op === "authorize").length, 0);
  const bytes = Buffer.from(prepares[0].requestUtf8Base64, "base64");
  assert.equal(hash(bytes), prepares[0].requestFingerprint);
  const spec = JSON.parse(bytes.toString("utf8"));
  assert.equal(spec.target.identity.jobId, submitted.body.data.jobId);
  const inputBefore = hash(await readFile(spec.inputPath));
  assert.equal(inputBefore, calibrationBefore);
  const maintenance = await call("GET", "/v1/maintenance");
  assert.equal(maintenance.status, 200);
  assert.equal(maintenance.body.data.bootId, submitted.body.data.bootId);
  const next = await call("GET", "/v1/maintenance");
  assert.equal(next.status, 200);
  assert.deepEqual(next.body.data.store, maintenance.body.data.store);
  const capabilities = await call("GET", "/v1/capabilities");
  assert.equal(capabilities.body.data.ready, false);
  const rendered = JSON.stringify(maintenance.body);
  for (const secret of [credential.key, storeDirectory, config.options.installationRoot, spec.inputPath,
    spec.outputPath, prepares[0].requestId, prepares[0].executionId, spec.target.launchTicket]) assert(!rendered.includes(secret));
  const proof = { unauthorizedStatus: unauthorized.status, selfTestPosts: calls.filter((value) => value.method === "POST").length,
    maintenance, selfTest: submitted, sameJob: true, capabilities, calls, nativeFiles,
    calibrationPreserved: hash(await readFile(calibration)) === calibrationBefore,
    inputPreserved: hash(await readFile(spec.inputPath)) === inputBefore,
    sensitiveDataAbsent: true, serviceQualification: false, gpuInference: false };
  emit("node-prepared", { maintenance, workerDiagnostic: proof });
  // The same retained bridge is contained by the original native fixture only after this evidence is recorded.
  await originalClosed;
  const closed = new Promise((resolve) => runtime.server.once("close", resolve));
  runtime.close();
  await closed;
  const nativeFilesAfter = [];
  for (const file of nativeFiles) nativeFilesAfter.push({ ...file,
    sha256: hash(await readFile(join(payload, "native", file.role, file.name))) });
  assert.deepEqual(nativeFilesAfter, nativeFiles);
  return { ...proof, nativeFilesAfter, workerClosedAfterContainment: true };
}
