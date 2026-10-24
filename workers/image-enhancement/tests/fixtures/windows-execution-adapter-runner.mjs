import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const configPath = process.argv[2];
const configBytes = await readFile(configPath);
const config = JSON.parse(configBytes.toString("utf8"));
assert.equal(process.env.ZEB_WINDOWS_EXECUTION_ADAPTER_READER_PIN, "1");
assert(
  [
    "execution-node-natural",
    "execution-node-stop-soft",
    "execution-node-reader-loss-before-input",
    "execution-node-reader-loss-after-input",
  ].includes(config.scenario),
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const emit = (kind, value) => {
  const line = `${JSON.stringify({ kind, ...value })}\n`;
  if (kind === "node-result")
    writeFileSync(join(dirname(configPath), "node-adapter-return.json"), line, {
      flag: "wx",
    });
  return process.stdout.write(line);
};
const attemptPath = join(dirname(configPath), "node-adapter-attempt.json");
const attemptBytes = await readFile(attemptPath);
const attemptText = new TextDecoder("utf-8", { fatal: true }).decode(
  attemptBytes,
);
assert.deepEqual(Buffer.from(attemptText, "utf8"), attemptBytes);
const attempt = JSON.parse(attemptText);
const requestBytes = Buffer.from(config.request.requestUtf8Base64, "base64");
assert.equal(requestBytes.toString("base64"), config.request.requestUtf8Base64);
assert.equal(hash(requestBytes), config.request.requestFingerprint);
const spec = JSON.parse(
  new TextDecoder("utf-8", { fatal: true }).decode(requestBytes),
);
assert.deepEqual(spec.target, config.expected.target);
assert.deepEqual(spec.target, {
  identity: attempt.identity,
  launchTicket: attempt.launchTicket,
});
assert.equal(attempt.job.jobId, spec.target.identity.jobId);
assert.equal(
  attempt.executionPolicy.fingerprint,
  config.expected.executionPolicyFingerprint,
);
for (const field of [
  "executionPolicy",
  "firstStartedAt",
  "executionDeadlineAt",
  "inputPath",
  "workingDirectory",
  "outputPath",
])
  assert.deepEqual(spec[field], attempt[field]);
assert.deepEqual(spec.engine, attempt.job.plan.engine);
assert.equal(spec.engine.tile, attempt.tile);

const requiredSessionTimeoutMs =
  spec.executionPolicy.limits.executionTimeoutMs +
  spec.executionPolicy.limits.cancelGraceMs +
  config.options.limits.cleanupTimeoutMs;
assert(Number.isSafeInteger(requiredSessionTimeoutMs));
assert.equal(config.options.limits.sessionTimeoutMs, 45_000);
assert.equal(requiredSessionTimeoutMs, 70_000);
// This is this test's transport configuration; the original request is unchanged.
const bridge = {
  ...config.options,
  limits: {
    ...config.options.limits,
    sessionTimeoutMs: requiredSessionTimeoutMs,
  },
};
const journalLimits = Object.freeze({
  maxRequestBytes: 4 * 1_048_576,
  maxStdoutBytes: 1_048_576,
  maxStderrBytes: 65_536,
  readTimeoutMs: 60_000,
  cleanupTimeoutMs: 5_000,
});
const sequence = [];
const event = (role, name) =>
  sequence.push({ sequence: sequence.length, role, event: name });
const observations = {};
const observerErrors = [];
let bound;
let readerGate;
let readerInputFinishObserved = false;
let readerEndCallbackSucceeded = false;
let readerInputDeliveredSent = false;
function notifyReaderInputDelivered() {
  if (
    config.scenario !== "execution-node-reader-loss-after-input" ||
    readerInputDeliveredSent ||
    !readerInputFinishObserved ||
    !readerEndCallbackSucceeded
  )
    return;
  const facts = observations.journal.facts;
  assert(bound && readerGate);
  assert.equal(readerGate.facts.state, "released");
  assert.equal(facts.endCalls, 1);
  assert.equal(facts.endCallbacks, 1);
  assert.equal(facts.writeErrors, 0);
  assert.equal(facts.stdinFinish, true);
  assert.deepEqual(facts.errors, []);
  assert.deepEqual(observerErrors, []);
  readerInputDeliveredSent = true;
  event("journal", "reader-input-delivered");
  emit("node-reader-input-delivered", {
    candidatePid: facts.originalPid,
    executionId: bound.executionId,
    requestFingerprint: config.request.requestFingerprint,
    endCalls: facts.endCalls,
    endCallbacks: facts.endCallbacks,
    stdinFinish: true,
    endCallbackSucceeded: true,
  });
}
function joined(facts) {
  return (
    facts.exit?.code === 0 &&
    facts.exit.signal === null &&
    facts.close?.code === 0 &&
    facts.close.signal === null &&
    facts.stdoutEof &&
    facts.stderrEof &&
    facts.stdinFinish &&
    facts.stdinClose &&
    facts.stdoutClose &&
    facts.stderrClose
  );
}
function snapshot(role) {
  const observed = observations[role];
  if (!observed) return null;
  return structuredClone({
    ...observed.facts,
    stdoutBase64: Buffer.concat(observed.stdout).toString("base64"),
    stderrBase64: Buffer.concat(observed.stderr).toString("base64"),
  });
}
function terminalFacts(role) {
  const original = snapshot(role);
  if (!original) return null;
  const { invocation, events, input, frames, stdoutBase64, ...terminal } =
    original;
  return terminal;
}
function observeChild(role, child, executablePath, args, options) {
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const facts = {
    spawnCount: 1,
    originalPid: child.pid,
    originalObjectRetained: true,
    detachedRequested: options.detached === true,
    invocation: {
      executablePath,
      arguments: [...args],
      options: structuredClone(options),
    },
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
  const observed = {
    child,
    facts,
    closed,
    stdout: [],
    stderr: [],
    pending: Buffer.alloc(0),
  };
  observations[role] = observed;
  const note = (name) => {
    facts.events.push(name);
    event(role, name);
  };
  note("spawn-call");
  const capture = (callback) => {
    try {
      callback();
    } catch (error) {
      const message = `${error.name}:${error.message}`;
      facts.errors.push(message);
      observerErrors.push({ role, message });
    }
  };
  const childEmit = child.emit;
  child.emit = function (name, ...values) {
    capture(() => {
      if (name === "spawn") note("spawn");
      else if (name === "error") facts.errors.push(`child:${values[0].name}`);
      else if (name === "exit") {
        facts.exit = { code: values[0], signal: values[1] };
        note("exit");
      } else if (name === "close") {
        facts.close = { code: values[0], signal: values[1] };
        note("child-close");
        resolveClosed();
      }
    });
    return childEmit.call(this, name, ...values);
  };
  const originalKill = child.kill;
  child.kill = function (...values) {
    facts.killCalls++;
    note("kill-call");
    return originalKill.apply(this, values);
  };
  for (const [name, stream] of [
    ["stdin", child.stdin],
    ["stdout", child.stdout],
    ["stderr", child.stderr],
  ]) {
    assert(stream);
    const streamEmit = stream.emit;
    // Observe original emissions without adding data listeners or resuming pipes.
    stream.emit = function (kind, ...values) {
      capture(() => {
        if (kind === "error") facts.errors.push(`${name}:${values[0].name}`);
        else if (kind === "close") {
          facts[`${name}Close`] = true;
          note(`${name}-close`);
        } else if (name === "stdin" && kind === "finish") {
          facts.stdinFinish = true;
          note("stdin-finish");
        } else if (name !== "stdin" && kind === "end") {
          facts[`${name}Eof`] = true;
          note(`${name}-eof`);
          if (name === "stdout" && role === "bridge")
            assert.equal(observed.pending.length, 0);
        } else if (name !== "stdin" && kind === "data") {
          const bytes = values[0];
          assert(Buffer.isBuffer(bytes));
          facts[name === "stdout" ? "outputBytes" : "stderrBytes"] +=
            bytes.length;
          const limit =
            name === "stderr"
              ? role === "journal"
                ? journalLimits.maxStderrBytes
                : bridge.limits.maxHelperStderrBytes
              : role === "journal"
                ? journalLimits.maxStdoutBytes
                : bridge.limits.maxSessionOutputBytes;
          assert(
            facts[name === "stdout" ? "outputBytes" : "stderrBytes"] <= limit,
          );
          observed[name].push(Buffer.from(bytes));
          if (name === "stdout" && role === "bridge") {
            observed.pending = Buffer.concat([observed.pending, bytes]);
            let newline;
            while ((newline = observed.pending.indexOf(10)) !== -1) {
              const raw = observed.pending.subarray(0, newline + 1);
              observed.pending = observed.pending.subarray(newline + 1);
              assert(
                raw.length <= bridge.limits.maxResponseFrameBytes &&
                  !raw.includes(13),
              );
              const frame = JSON.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(raw),
              );
              facts.frames.push({ rawBase64: raw.toString("base64"), frame });
              note(`frame:${frame.kind}`);
              if (frame.kind === "bound") {
                assert.equal(bound, undefined);
                assert.equal(frame.v, 1);
                assert.deepEqual(
                  Object.keys(frame).sort(),
                  [
                    "v",
                    "kind",
                    "executionId",
                    "bridge",
                    "helper",
                    "state",
                  ].sort(),
                );
                bound = {
                  executionId: frame.executionId,
                  bridge: frame.bridge,
                  helper: frame.helper,
                  state: frame.state,
                };
                emit("node-bound", { binding: bound });
              }
            }
            assert(
              observed.pending.length <= bridge.limits.maxResponseFrameBytes,
            );
          }
        }
      });
      const returned = streamEmit.call(this, kind, ...values);
      if (role === "journal" && name === "stdin" && kind === "finish") {
        readerInputFinishObserved = true;
        notifyReaderInputDelivered();
      }
      return returned;
    };
  }
  const inputBytes = (values) => {
    const chunk = values[0];
    return typeof chunk === "string" ||
      Buffer.isBuffer(chunk) ||
      ArrayBuffer.isView(chunk)
      ? Buffer.from(chunk, typeof values[1] === "string" ? values[1] : "utf8")
      : undefined;
  };
  for (const method of ["write", "end"]) {
    const original = child.stdin[method];
    child.stdin[method] = function (...values) {
      facts[`${method}Calls`]++;
      note(`stdin-${method}-call`);
      const bytes = inputBytes(values);
      if (bytes) {
        facts.input.push(bytes.toString("base64"));
        if (role === "bridge") {
          capture(() => {
            const frame = JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(bytes),
            );
            note(`input:${frame.kind}:${frame.op ?? ""}`);
          });
        }
      }
      const callback = values.at(-1);
      if (typeof callback === "function")
        values[values.length - 1] = (error) => {
          facts[`${method}Callbacks`]++;
          if (error) facts.writeErrors++;
          note(`stdin-${method}-callback`);
          const returned = callback(error);
          if (role === "journal" && method === "end" && !error) {
            readerEndCallbackSucceeded = true;
            notifyReaderInputDelivered();
          }
          return returned;
        };
      return original.apply(this, values);
    };
  }
}
function holdReaderInput(child) {
  const savedObservedEnd = child.stdin.end;
  child.stdin.end = function (...values) {
    assert.equal(readerGate, undefined);
    assert.equal(this, child.stdin);
    assert.equal(values.length, 2);
    assert(Buffer.isBuffer(values[0]));
    assert.equal(typeof values[1], "function");
    assert(Number.isSafeInteger(child.pid) && child.pid > 0);
    assert(bound);
    const savedThis = this;
    const savedArgs = values;
    const savedBuffer = values[0];
    const savedCallback = values[1];
    const facts = {
      candidatePid: child.pid,
      heldCount: 1,
      releaseCount: 0,
      originalEndInvocations: 0,
      state: "held",
      savedThisIsOriginalStdin: savedThis === child.stdin,
      savedArgumentCount: savedArgs.length,
      bufferReferencePreserved: false,
      callbackReferencePreserved: false,
      observedEndReturnIsOriginalStdin: false,
    };
    readerGate = {
      facts,
      release(identity) {
        assert.equal(facts.state, "held");
        const observed = observations.journal.facts;
        assert.equal(observed.exit, null);
        assert.equal(observed.close, null);
        assert.deepEqual(observed.errors, []);
        assert(!child.stdin.destroyed);
        assert.equal(identity.pid, child.pid);
        assert.equal(savedArgs[0], savedBuffer);
        assert.equal(savedArgs[1], savedCallback);
        facts.state = "released";
        facts.releaseCount++;
        facts.identity = identity;
        facts.bufferReferencePreserved = savedArgs[0] === savedBuffer;
        facts.callbackReferencePreserved = savedArgs[1] === savedCallback;
        event("journal", "reader-input-released");
        facts.originalEndInvocations++;
        facts.observedEndReturnIsOriginalStdin =
          savedObservedEnd.apply(savedThis, savedArgs) === child.stdin;
        assert(facts.observedEndReturnIsOriginalStdin);
      },
    };
    event("journal", "reader-input-held");
    emit("node-reader-input-held", {
      candidatePid: child.pid,
      executionId: bound.executionId,
      requestFingerprint: config.request.requestFingerprint,
    });
    return child.stdin;
  };
}
const spawnOriginal = childProcess.spawn;
childProcess.spawn = function (executablePath, args, options) {
  let role;
  if (
    executablePath === bridge.executablePath &&
    args[0] === "--control-bridge"
  ) {
    role = "bridge";
    assert.equal(args.length, 2);
    assert.deepEqual(JSON.parse(args[1]), {
      v: 1,
      helperPath: bridge.helperPath,
      recordsRoot: bridge.recordsRoot,
      installationRoot: bridge.installationRoot,
      expectedManifestSha256: bridge.expectedManifestSha256,
      environment: bridge.environment,
      limits: bridge.limits,
    });
    assert.equal(options.detached, true);
  } else if (
    executablePath === bridge.helperPath &&
    args[0] === "--read-records"
  ) {
    role = "journal";
    assert.deepEqual(args, ["--read-records", bridge.recordsRoot]);
    assert.equal(options.detached, true);
    assert(observations.bridge && joined(observations.bridge.facts));
  } else assert.fail("unexpected-adapter-child");
  assert.equal(observations[role], undefined);
  assert.deepEqual(options.env, bridge.environment);
  const child = spawnOriginal.call(this, executablePath, args, options);
  observeChild(role, child, executablePath, args, options);
  if (role === "journal") holdReaderInput(child);
  return child;
};
syncBuiltinESMExports();

const modulePaths = [
  join(dirname(config.hostModule), "windows-execution-adapter.js"),
  join(dirname(config.hostModule), "windows-prepare-payload.js"),
];
const moduleArtifacts = await Promise.all(
  modulePaths.map(async (path) => ({
    path,
    sha256: hash(await readFile(path)),
  })),
);
const { freezeWindowsPrepareRequest } = await import(
  pathToFileURL(modulePaths[1]).href
);
assert.deepEqual(freezeWindowsPrepareRequest(attempt), config.request);
const { createWindowsExecutionAdapter } = await import(
  pathToFileURL(modulePaths[0]).href
);
const adapter = createWindowsExecutionAdapter({ bridge, journalLimits });
const controller = new AbortController();
const guards = {};
function guard(name) {
  const state = { current: true, permits: 0 };
  guards[name] = state;
  return {
    signal: controller.signal,
    stillCurrent: () => state.current,
    takeSendPermission() {
      assert(state.current && state.permits === 0);
      state.permits++;
      event("adapter", `${name}-permit`);
      return true;
    },
  };
}
function seal(name) {
  guards[name].current = false;
  event("adapter", `${name}-guard-sealed`);
}
let startSoft;
const softStart = new Promise((resolve) => {
  startSoft = resolve;
});
let softStarted = false;
const controls = createInterface({ input: process.stdin, crlfDelay: Infinity });
const controlsClosed = new Promise((resolve) =>
  controls.once("close", resolve),
);
controls.on("line", (line) => {
  try {
    const command = JSON.parse(line);
    if (command.command === "release-reader-input") {
      assert.deepEqual(
        Object.keys(command).sort(),
        ["command", "executionId", "identity", "requestFingerprint"].sort(),
      );
      assert(bound);
      assert.equal(command.executionId, bound.executionId);
      assert.equal(
        command.requestFingerprint,
        config.request.requestFingerprint,
      );
      assert.deepEqual(
        Object.keys(command.identity).sort(),
        ["pid", "creationFileTime"].sort(),
      );
      assert(
        Number.isSafeInteger(command.identity.pid) &&
          command.identity.pid > 0 &&
          command.identity.pid <= 0xffffffff,
      );
      assert.equal(typeof command.identity.creationFileTime, "string");
      assert(/^[1-9][0-9]*$/.test(command.identity.creationFileTime));
      assert(BigInt(command.identity.creationFileTime) <= 0xffffffffffffffffn);
      assert(readerGate);
      readerGate.release(command.identity);
      return;
    }
    assert.deepEqual(command, { command: "request-soft" });
    assert.equal(config.scenario, "execution-node-stop-soft");
    assert(!softStarted);
    softStarted = true;
    event("control", "request-soft");
    startSoft();
  } catch (error) {
    observerErrors.push({
      role: "control",
      message: `${error.name}:${error.message}`,
    });
  }
});

let prepareResult,
  authorizationResult,
  markerAfterPrepare,
  closeResult,
  stopProof;
let failure;
const callbacks = [];
let unsubscribe;
try {
  const prepareGuard = guard("prepare");
  let descriptor;
  try {
    descriptor = await adapter.prepare(attempt, prepareGuard);
  } finally {
    seal("prepare");
  }
  prepareResult = { kind: "prepared", descriptor };
  assert(bound);
  markerAfterPrepare = existsSync(config.marker);
  emit("node-prepared", { result: prepareResult });
  let resolveExit;
  const observedExit = new Promise((resolve) => {
    resolveExit = resolve;
  });
  unsubscribe = adapter.observeExit(
    config.expected.target,
    descriptor,
    (exit) => {
      event("adapter", "exit-callback");
      callbacks.push({
        exit: structuredClone(exit),
        frozen: Object.isFrozen(exit),
        identityFrozen: Object.isFrozen(exit.identity),
        descriptorFrozen: Object.isFrozen(exit.descriptor),
        completionOwn: Object.hasOwn(exit, "completion"),
        prepareCurrent: guards.prepare.current,
        authorizeCurrent: guards.authorize?.current ?? null,
        factsAtCallback: terminalFacts("bridge"),
        journalFactsAtCallback: terminalFacts("journal"),
      });
      resolveExit(exit);
    },
  );
  event("adapter", "observer-installed");
  const authGuard = guard("authorize");
  event("adapter", "authorize-call");
  try {
    await adapter.authorize(attempt, descriptor, authGuard);
  } finally {
    seal("authorize");
  }
  authorizationResult = { kind: "authorized" };
  emit("node-authorize-result", { result: authorizationResult });
  if (config.scenario === "execution-node-stop-soft") {
    await softStart;
    const grace = spec.executionPolicy.limits.cancelGraceMs;
    const stopRequestedAt = Date.now() - Math.floor((grace * 3) / 4);
    const pair = Object.freeze({
      stopRequestedAt,
      terminateAfterAt: stopRequestedAt + grace,
    });
    const request = Object.freeze({ mode: "soft", ...pair });
    const stopGuard = guard("soft");
    const stopping = adapter.requestStop(
      config.expected.target,
      descriptor,
      request,
      stopGuard,
    );
    emit("node-stop-sent", {
      pair,
      facts: { spawnCount: 1, input: snapshot("bridge").input },
    });
    try {
      await stopping;
    } finally {
      seal("soft");
    }
    const softResult = { kind: "stop-requested" };
    stopProof = {
      pair,
      pairFrozen: Object.isFrozen(pair),
      softResult,
      softPermits: guards.soft.permits,
    };
    emit("node-soft-result", {
      result: softResult,
      softPermits: guards.soft.permits,
    });
  }
  await observedExit;
  assert.equal(callbacks.length, 1);
  assert(observations.bridge && observations.journal);
  assert(
    joined(observations.bridge.facts) && joined(observations.journal.facts),
  );
  await Promise.all([observations.bridge.closed, observations.journal.closed]);
  assert(readerGate);
  assert.equal(readerGate.facts.releaseCount, 1);
  assert.equal(readerGate.facts.originalEndInvocations, 1);
  assert.deepEqual(observerErrors, []);
  assert.equal(callbacks[0].prepareCurrent, false);
  assert.equal(callbacks[0].authorizeCurrent, false);
  event("adapter", "close-call-after-exit");
  closeResult = await adapter.close();
  event("adapter", "close-returned");
  assert.equal(closeResult, "closed");
  unsubscribe();
} catch (error) {
  failure = `${error.name}:${error.message}`;
  process.exitCode = 1;
}
const journalFacts = snapshot("journal");
let rawJournalSnapshot;
try {
  if (journalFacts?.stdoutBase64)
    rawJournalSnapshot = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.from(journalFacts.stdoutBase64, "base64"),
      ),
    );
} catch (error) {
  failure ??= `${error.name}:${error.message}`;
  process.exitCode = 1;
}
emit("node-result", {
  adapter: true,
  prepareResult,
  authorizationResult,
  closeResult,
  preparePermits: guards.prepare?.permits ?? 0,
  authPermits: guards.authorize?.permits ?? 0,
  markerAfterPrepare,
  ...(stopProof ? { stopProof } : {}),
  inputProof: {
    attemptPath,
    attemptSha256: hash(attemptBytes),
    attemptBytesBase64: attemptBytes.toString("base64"),
    configPath,
    configSha256: hash(configBytes),
    carrier: config.request,
    originalPolicy: spec.executionPolicy,
    firstStartedAt: spec.firstStartedAt,
    executionDeadlineAt: spec.executionDeadlineAt,
    moduleArtifacts,
  },
  transport: {
    source: "explicit-test-only-transport-configuration",
    receivedBridge: config.options,
    effectiveBridge: bridge,
    journalLimits,
    requiredSessionTimeoutMs,
  },
  factsScope: "original-node-child-and-stream-events",
  factsAtReturn: snapshot("bridge"),
  journalFacts,
  readerInputGate: readerGate?.facts ?? null,
  rawJournalSnapshot,
  allChildSpawnCount: Object.keys(observations).length,
  callbackCount: callbacks.length,
  callbacks,
  sequence,
  observerErrors,
  node: process.version,
  libuv: process.versions.uv,
  ...(failure === undefined ? {} : { failure }),
});
// The unmodified native harness closes this test input only after node-result.
await controlsClosed;
