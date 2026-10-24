import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const config = JSON.parse(await readFile(process.argv[2], "utf8"));
const workerDiagnosticMode = config.scenario === "execution-node-worker-prepare-installation-denied";
const emit = (kind, value) =>
  process.stdout.write(`${JSON.stringify({ kind, ...value })}\n`);
const facts = {
  spawnCount: 0,
  detachedRequested: false,
  events: [],
  input: [],
  frames: [],
  outputBytes: 0,
  stderrBytes: 0,
  writeCalls: 0,
  writeCallbacks: 0,
  writeErrors: 0,
  endCalls: 0,
  endCallbacks: 0,
  stdoutEof: false,
  stderrEof: false,
  stdinClose: false,
  stdoutClose: false,
  stderrClose: false,
  stdinFinish: false,
  errors: [],
  exit: null,
  close: null,
  killCalls: 0,
};
let originalChild;
let pending = Buffer.alloc(0);
let endingResolve;
const ending = new Promise((resolve) => {
  endingResolve = resolve;
});
let originalCloseResolve;
const originalClosed = new Promise((resolve) => {
  originalCloseResolve = resolve;
});
const spawnOriginal = childProcess.spawn;
childProcess.spawn = function (...args) {
  const child = spawnOriginal(...args);
  originalChild = child;
  facts.spawnCount++;
  facts.detachedRequested = args[2]?.detached === true;
  facts.originalPid = child.pid;
  const event = (name) => facts.events.push(name);
  child.on("spawn", () => event("spawn"));
  child.on("error", (error) => facts.errors.push(error.name));
  child.on("exit", (code, signal) => {
    facts.exit = { code, signal };
    event("exit");
  });
  child.on("close", (code, signal) => {
    facts.close = { code, signal };
    event("child-close");
    originalCloseResolve();
  });
  const killOriginal = child.kill;
  child.kill = function (...values) {
    facts.killCalls++;
    return killOriginal.apply(this, values);
  };
  for (const [name, stream] of [
    ["stdin", child.stdin],
    ["stdout", child.stdout],
    ["stderr", child.stderr],
  ]) {
    stream.on("error", (error) => facts.errors.push(`${name}:${error.name}`));
    stream.on("close", () => {
      facts[`${name}Close`] = true;
      event(`${name}-close`);
    });
  }
  child.stdin.on("finish", () => {
    facts.stdinFinish = true;
    event("stdin-finish");
  });
  const writeOriginal = child.stdin.write;
  child.stdin.write = function (...values) {
    facts.writeCalls++;
    facts.input.push(Buffer.from(values[0]).toString("base64"));
    const callback = values.at(-1);
    if (typeof callback === "function")
      values[values.length - 1] = (error) => {
        facts.writeCallbacks++;
        if (error) facts.writeErrors++;
        callback(error);
      };
    if (workerDiagnosticMode && JSON.parse(Buffer.from(values[0]).toString("utf8")).op === "prepare") {
      // Only the original test write waits for original bridge/helper registration; bytes/callback are unchanged.
      void prepareStart.then(() => writeOriginal.apply(this, values));
      return true;
    }
    return writeOriginal.apply(this, values);
  };
  const endOriginal = child.stdin.end;
  child.stdin.end = function (...values) {
    facts.endCalls++;
    const callback = values.at(-1);
    if (typeof callback === "function")
      values[values.length - 1] = (error) => {
        facts.endCallbacks++;
        if (error) facts.writeErrors++;
        callback(error);
      };
    return endOriginal.apply(this, values);
  };
  child.stdout.on("data", (bytes) => {
    try {
      facts.outputBytes += bytes.length;
      assert(facts.outputBytes <= config.options.limits.maxSessionOutputBytes);
      pending = Buffer.concat([pending, bytes]);
      let newline;
      while ((newline = pending.indexOf(10)) !== -1) {
        const raw = pending.subarray(0, newline + 1);
        pending = pending.subarray(newline + 1);
        assert(
          raw.length <= config.options.limits.maxResponseFrameBytes &&
            !raw.includes(13),
        );
        const frame = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(raw),
        );
        facts.frames.push({ rawBase64: raw.toString("base64"), frame });
        if (workerDiagnosticMode && frame.kind === "bound") {
          const { executionId, bridge, helper, state } = frame;
          emit("node-bound", { binding: { executionId, bridge, helper, state } });
        }
        if (frame.kind === "ending") {
          event("ending-observed");
          emit("node-fixture-stage", {
            stage: "ending-observed",
            rawBase64: raw.toString("base64"),
          });
          endingResolve();
        }
        if (frame.kind === "state" && frame.state.sealReason === "engine-exit")
          emit("node-engine-exit-state", { state: frame.state });
      }
      assert(pending.length <= config.options.limits.maxResponseFrameBytes);
    } catch (error) {
      facts.errors.push(error.name);
    }
  });
  child.stdout.on("end", () => {
    facts.stdoutEof = true;
    event("stdout-eof");
    if (pending.length) facts.errors.push("partial-bridge-eof");
  });
  child.stderr.on("data", (bytes) => {
    facts.stderrBytes += bytes.length;
  });
  child.stderr.on("end", () => {
    facts.stderrEof = true;
    event("stderr-eof");
  });
  return child;
};
syncBuiltinESMExports();

let closeSettled = false;
let snapshotTaken = false;
let startSoft, startForce;
const softStart = new Promise((resolve) => {
  startSoft = resolve;
});
const forceStart = new Promise((resolve) => {
  startForce = resolve;
});
let softStarted = false,
  forceStarted = false;
let beginPrepare, prepareStarted = false;
const prepareStart = new Promise((resolve) => { beginPrepare = resolve; });
const controls = createInterface({ input: process.stdin, crlfDelay: Infinity });
controls.on("line", (line) => {
  try {
    const command = JSON.parse(line);
    assert.deepEqual(Object.keys(command), ["command"]);
    if (command.command === "begin-prepare") {
      assert((workerDiagnosticMode || config.scenario === "execution-node-prepare-installation-denied") && !prepareStarted);
      prepareStarted = true;
      beginPrepare();
      return;
    }
    if (command.command === "request-soft") {
      assert(!softStarted);
      softStarted = true;
      startSoft();
      return;
    }
    if (command.command === "request-force") {
      assert(!forceStarted);
      forceStarted = true;
      startForce();
      return;
    }
    assert(command.command === "snapshot" && !snapshotTaken);
    snapshotTaken = true;
    emit("node-snapshot", {
      facts: structuredClone(facts),
      closeSettled,
      closeResult,
      originalBridgeAlive:
        !!originalChild &&
        originalChild.exitCode === null &&
        originalChild.signalCode === null,
    });
  } catch (error) {
    facts.errors.push(error.name);
  }
});

const { createWindowsControlBridgeHost } = await import(
  pathToFileURL(config.hostModule).href
);
const host = workerDiagnosticMode ? undefined : createWindowsControlBridgeHost(config.options);
const controller = new AbortController();
let preparePermits = 0,
  authPermits = 0;
let prepareResult, authorizationResult, closeResult;
let passiveClosure, passiveWaitAtStart;
let markerAfterPrepare;
let failure;
let stopProof;
let workerDiagnostic;
const callerDeathStage = {
  "execution-node-caller-death-never-prepare": "never-prepare",
  "execution-node-caller-death-prepared": "prepared",
  "execution-node-caller-death-running": "running",
}[config.scenario];
function holdForCallerDeath(binding) {
  emit("node-death-ready", {
    stage: callerDeathStage,
    binding,
    descriptor: prepareResult?.descriptor ?? null,
    preparePermits,
    authPermits,
    markerPresent: existsSync(config.marker),
    facts: structuredClone(facts),
  });
  return new Promise(() => {});
}
try {
  if (workerDiagnosticMode) {
    const { runWorkerDiagnostic } = await import("./windows-worker-prepare-diagnostic.mjs");
    workerDiagnostic = await runWorkerDiagnostic({ config, emit, facts, originalClosed, controller });
  } else {
  const opened = await host.open(controller.signal, () => true);
  assert.equal(opened.kind, "bound");
  emit("node-bound", { binding: opened.binding });
  if (config.scenario === "execution-node-prepare-installation-denied") await prepareStart;
  if (callerDeathStage === "never-prepare")
    await holdForCallerDeath(opened.binding);
  prepareResult = await host.prepare(config.request, config.expected, {
    signal: controller.signal,
    stillCurrent: () => true,
    takeSendPermission() {
      preparePermits++;
      return true;
    },
  });
  emit("node-prepared", { result: prepareResult });
  markerAfterPrepare = existsSync(config.marker);
  if (config.scenario === "execution-node-prepare-installation-denied") assert.equal(prepareResult.kind, "unknown");
  else {
  assert.equal(prepareResult.kind, "prepared");
  if (callerDeathStage === "prepared") await holdForCallerDeath(opened.binding);
  authorizationResult = await host.authorize(
    config.expected.target,
    prepareResult.descriptor,
    config.request.requestFingerprint,
    {
      signal: controller.signal,
      stillCurrent: () => true,
      takeSendPermission() {
        authPermits++;
        return config.scenario !== "execution-node-deny-auth";
      },
    },
  );
  if (config.scenario === "execution-node-natural") {
    passiveClosure = host.whenClosed();
    passiveWaitAtStart = {
      endingObserved: facts.events.includes("ending-observed"),
      originalChildClosed: facts.close !== null,
      stdinEnded: originalChild.stdin.writableEnded,
      endCalls: facts.endCalls,
    };
    facts.events.push("passive-wait-started");
    emit("node-fixture-stage", {
      stage: "passive-wait-started",
      ...passiveWaitAtStart,
    });
  }
  emit("node-authorize-result", { result: authorizationResult });
  if (config.scenario.startsWith("execution-node-stop-")) {
    assert.equal(authorizationResult.kind, "authorized");
    await softStart;
    const grace = JSON.parse(
      Buffer.from(config.request.requestUtf8Base64, "base64").toString("utf8"),
    ).executionPolicy.limits.cancelGraceMs;
    const stopRequestedAt = Date.now() - Math.floor((grace * 3) / 4),
      terminateAfterAt = stopRequestedAt + grace;
    const pair = { stopRequestedAt, terminateAfterAt };
    let softPermits = 0,
      forcePermits = 0,
      softPending = true;
    const softGuard = {
      signal: controller.signal,
      stillCurrent: () => true,
      takeSendPermission() {
        softPermits++;
        return true;
      },
    };
    const forceGuard = {
      signal: controller.signal,
      stillCurrent: () => true,
      takeSendPermission() {
        forcePermits++;
        return true;
      },
    };
    const softRequest = { mode: "soft", ...pair },
      forceRequest = { mode: "force", ...pair };
    const soft = host.requestStop(
      config.expected.target,
      prepareResult.descriptor,
      softRequest,
      softGuard,
    );
    assert.equal(
      host.requestStop(
        config.expected.target,
        prepareResult.descriptor,
        softRequest,
        softGuard,
      ),
      soft,
    );
    void soft.then(() => {
      softPending = false;
    });
    emit("node-stop-sent", { pair, facts: structuredClone(facts) });
    let forceResult;
    if (config.scenario !== "execution-node-stop-soft") {
      await forceStart;
      assert(Date.now() > terminateAfterAt);
      const force = host.requestStop(
        config.expected.target,
        prepareResult.descriptor,
        forceRequest,
        forceGuard,
      );
      assert.equal(
        host.requestStop(
          config.expected.target,
          prepareResult.descriptor,
          forceRequest,
          forceGuard,
        ),
        force,
      );
      forceResult = await force;
      assert.equal(forceResult.kind, "stop-requested");
      emit("node-force-result", {
        result: forceResult,
        softPending,
        softPermits,
        forcePermits,
        facts: structuredClone(facts),
      });
      assert(softPending);
    }
    const softResult = await soft;
    assert.equal(
      host.requestStop(
        config.expected.target,
        prepareResult.descriptor,
        softRequest,
        softGuard,
      ),
      soft,
    );
    emit("node-soft-result", {
      result: softResult,
      softPermits,
      forcePermits,
      facts: structuredClone(facts),
    });
    stopProof = {
      pair,
      softResult,
      forceResult,
      softPermits,
      forcePermits,
      originalSoftPromiseRetained: true,
    };
  }
  if (callerDeathStage === "running") {
    assert.equal(authorizationResult.kind, "authorized");
    await holdForCallerDeath(opened.binding);
  }
  if (!passiveClosure) {
    // The real bridge notification lets the product host end its original stdin first.
    emit("node-fixture-stage", { stage: "waiting-ending" });
    await ending;
  }
  }
  }
} catch (error) {
  facts.errors.push(error.name);
  failure = error.name;
  process.exitCode = 1;
}
emit("node-fixture-stage", {
  stage: passiveClosure ? "before-passive-wait" : "before-product-close",
});
closeResult = workerDiagnosticMode ? "unknown" : await (passiveClosure ?? host.close());
closeSettled = true;
const factsAtCloseReturn = structuredClone(facts);
emit("node-fixture-stage", { stage: "product-close-returned", closeResult });
emit("node-fixture-stage", { stage: "waiting-original-child-close" });
await originalClosed;
emit("node-fixture-stage", { stage: "original-child-close-observed" });
emit("node-result", {
  prepareResult,
  authorizationResult,
  closeResult,
  preparePermits,
  authPermits,
  markerAfterPrepare,
  passiveWaitAtStart,
  ...(stopProof ? { stopProof } : {}),
  ...(workerDiagnostic ? { workerDiagnostic } : {}),
  node: process.version,
  libuv: process.versions.uv,
  factsAtCloseReturn,
  factsAtReturn: structuredClone(facts),
  factsScope: "original-node-child-and-stream-events",
  ...(failure === undefined ? {} : { failure }),
});
// The native fixture closes this original test-control input after node-result.
await new Promise((resolve) => controls.once("close", resolve));
