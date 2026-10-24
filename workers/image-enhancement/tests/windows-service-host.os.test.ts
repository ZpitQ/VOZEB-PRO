import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { runnerLimits } from "./storage-fixtures.js";

type Value = Record<string, unknown>;
type Close = { code: number | null; signal: NodeJS.Signals | null };
type Pin = {
  identity: { pid: number; creationFileTime: string };
  source: string;
  independentCreationPin: boolean;
  originalRetained: boolean;
  originalJoined: boolean;
  alive: boolean;
  exitCode: number | null;
  sid: string;
};
type Census = {
  activeProcesses: number;
  totalProcesses: number;
  memberIds: number[];
  queryHandleClosed: boolean;
};
type SystemConsolePin = Pin & {
  requestedAccess: number;
  imagePath: string;
  imageIdentity: string;
  expectedImagePath: string;
  expectedImageIdentity: string;
  sameSid: boolean;
  nonInherited: boolean;
  inOriginalJobVerified: boolean;
  qualifiedSystemConsole: boolean;
  signaled: boolean;
};
type Receipt = Value & {
  scenario: string;
  passed: boolean;
  failures: string[];
  start?: {
    startSucceeded: boolean;
    startFailureType: string | null;
    workerStarts?: number;
    completionCompleted: boolean;
    authorized?: boolean;
    jobHandleFlags?: number;
    processHandleFlags?: number;
    root?: { pid: number; creationFileTime: string };
  };
  beforeInjection?: {
    hostAlive: boolean;
    rootAlive: boolean;
    hungAlive: boolean | null;
    queryHandlesClosedBeforeInjection: boolean;
    noMoreSpawnsAfterReady: boolean;
    initialCensus: Census;
    census: Census;
    registeredInnerIdentities: Pin["identity"][];
    systemConsoleCount: number;
    systemConsolePins: SystemConsolePin[];
    pins: Pin[];
  };
  completed?: Value & { cleanup: Value };
  hostDeath?: Value;
  cleanup: Value & {
    guardianUsed?: boolean;
    injectionOccurred?: boolean;
    allPinsJoined?: boolean;
    expectedPins?: number;
    observedPins?: number;
    workerStarts?: number;
    safetyTreeExit?: { activeProcesses: number; engineExitCode: number };
    pins?: Pin[];
    systemConsoleCount?: number;
    systemConsolePins?: SystemConsolePin[];
  };
  stopped?: boolean;
  sameStopTask?: boolean;
  secondStartRejected?: boolean;
  workerStarts?: number;
};

const selected = process.env.ZEB_WINDOWS_SERVICE_HOST_OS_TESTS === "1";
const windowsSuite = selected ? describe : describe.skip;
const executionMs = runnerLimits.executionTimeoutMs;
const cleanupMs = runnerLimits.cancelGraceMs;
const fixtureMs = executionMs + cleanupMs;
const testMs = fixtureMs + cleanupMs;
const captureLimit = 4 * 1_048_576;
let fixture: string, emptyProduct: string, evidenceRoot: string;
const main = resolve(
  import.meta.dirname,
  "fixtures/windows-service-host-worker.mjs",
);
const gracefulMain = resolve(import.meta.dirname, "fixtures/windows-service-host-graceful-worker.mjs");
const startupMain = resolve(import.meta.dirname, "../native/windows-service-host-fixture/startup-observation-root.mjs");
const serviceStartupMain = resolve(import.meta.dirname, "../native/windows-service-host-fixture/service-startup-root.mjs");

async function artifacts() {
  return Promise.all(
    [
      fixture,
      join(dirname(fixture), "WindowsServiceHostFixture.dll"),
      join(dirname(fixture), "WindowsServiceHost.dll"),
      join(dirname(fixture), "WindowsSupervisor.dll"),
      emptyProduct,
      join(dirname(emptyProduct), "WindowsServiceHost.dll"),
      process.execPath,
      main,
      gracefulMain,
      startupMain,
      serviceStartupMain,
    ].map(async (path) => ({
      path,
      sha256: createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    })),
  );
}

async function capture(executable: string, args: string[], directory: string) {
  const before = await artifacts();
  const child = spawn(executable, args, {
    shell: false,
    windowsHide: true,
    cwd: directory,
    stdio: "pipe",
  });
  const stdout: Buffer[] = [],
    stderr: Buffer[] = [];
  const errors: string[] = [],
    events: string[] = [];
  let bytes = 0,
    stdoutEof = false,
    stderrEof = false,
    guardianUsed = false;
  let exit: Close | undefined, close: Close | undefined;
  const fail = (error: unknown) => errors.push(String(error));
  child.once("error", fail);
  child.stdin.once("error", fail);
  child.stdout.once("error", fail);
  child.stderr.once("error", fail);
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes <= captureLimit) stdout.push(Buffer.from(chunk));
    else fail("Fixture capture overflow.");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes <= captureLimit) stderr.push(Buffer.from(chunk));
    else fail("Fixture capture overflow.");
  });
  child.stdout.once("end", () => {
    stdoutEof = true;
    events.push("stdout-eof");
  });
  child.stderr.once("end", () => {
    stderrEof = true;
    events.push("stderr-eof");
  });
  child.once("exit", (code, signal) => {
    exit = { code, signal };
    events.push("exit");
  });
  child.stdin.end();
  const closed = new Promise<Close>((resolveClosed) => {
    child.once("close", (code, signal) => {
      close = { code, signal };
      events.push("close");
      resolveClosed(close);
    });
  });
  let guard: ReturnType<typeof setTimeout> | undefined;
  let closeGuard: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        guard = setTimeout(() => {
          guardianUsed = true;
          if (!child.kill())
            fail(
              "Emergency termination of the original caller fixture was rejected.",
            );
          closeGuard = setTimeout(
            () =>
              reject(
                new Error(
                  "Emergency fixture termination did not join its original close.",
                ),
              ),
            cleanupMs,
          );
          void closed.then(() => {
            if (closeGuard) clearTimeout(closeGuard);
            reject(
              new Error(
                "Fixture exceeded the unchanged execution and cleanup bounds; guardian was used.",
              ),
            );
          });
        }, fixtureMs);
      }),
    ]);
  } catch (error) {
    fail(error);
  } finally {
    if (guard) clearTimeout(guard);
    if (closeGuard) clearTimeout(closeGuard);
  }
  const result = {
    args,
    executable,
    directory,
    before,
    after: await artifacts(),
    errors,
    events,
    exit,
    close,
    stdoutEof,
    stderrEof,
    guardianUsed,
    stdoutBase64: Buffer.concat(stdout).toString("base64"),
    stderrBase64: Buffer.concat(stderr).toString("base64"),
  };
  await writeFile(
    join(directory, "caller-evidence.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    { flag: "wx" },
  );
  return result;
}

async function exercise(scenario: string) {
  const directory = await mkdtemp(join(evidenceRoot, `${scenario}-`));
  const caller = await capture(
    fixture,
    [
      "case",
      scenario,
      directory,
      String(executionMs),
      String(cleanupMs),
      process.execPath,
      scenario.startsWith("graceful-") ? gracefulMain : main,
    ],
    directory,
  );
  const receipt = JSON.parse(
    Buffer.from(caller.stdoutBase64, "base64").toString("utf8"),
  ) as Receipt;
  expect(
    JSON.parse(
      await readFile(join(directory, "service-host-evidence.json"), "utf8"),
    ),
  ).toEqual(receipt);
  process.stdout.write(
    `[WINDOWS-SERVICE-HOST] ${JSON.stringify({ scenario, directory, start: receipt.start, passed: receipt.passed, failures: receipt.failures, callerGuardianUsed: caller.guardianUsed, cleanup: receipt.cleanup })}\n`,
  );
  return { caller, receipt };
}

function expectCaller(caller: Awaited<ReturnType<typeof capture>>) {
  expect(caller.errors).toEqual([]);
  expect(caller.guardianUsed).toBe(false);
  expect(caller.exit).toEqual({ code: 0, signal: null });
  expect(caller.close).toEqual(caller.exit);
  expect(caller.stdoutEof && caller.stderrEof).toBe(true);
  expect(caller.stderrBase64).toBe("");
  expect(caller.after).toEqual(caller.before);
}

async function exerciseServiceStartup(
  scenario: "schedule" | "early-stop" | "post-authorize-disconnect" | "validation-before-start",
) {
  const directory = await mkdtemp(join(evidenceRoot, "service-startup-" + scenario + "-"));
  const caller = await capture(fixture, [
    "service-startup-case", scenario, directory, process.execPath, serviceStartupMain,
    String(5_000), String(5_000),
  ], directory);
  expectCaller(caller);
  const receipt = JSON.parse(Buffer.from(caller.stdoutBase64, "base64").toString("utf8")) as Value;
  expect(JSON.parse(await readFile(join(directory, "service-host-evidence.json"), "utf8"))).toEqual(receipt);
  expect(receipt).toMatchObject({
    scenario, passed: true, failures: [], technicalSameUser: true,
    actualScmOnStartExercised: false, crossSidScmAccepted: false,
    guardianUsed: false, originalsJoined: true, safetyTree: { activeProcesses: 0 },
    hostStdout: { eof: true, errorType: null }, hostStderr: { eof: true, errorType: null },
    hostPin: { originalRetained: true, originalJoined: true, alive: false },
    completed: { lifecycleJoined: true, observationDisposed: true, secondStartRejected: true },
    scope: "technical shared service startup scheduling/lifetime only; no actual SCM OnStart, cross-SID, caller, FailureProof or Recover",
  });
  if (scenario === "schedule" || scenario === "post-authorize-disconnect") {
    expect(receipt).toMatchObject({
      queued: { callReturned: true, duplicateRejected: true, startupCompleted: false, lifecycleCompleted: false },
      beforeAck: { authorized: false, sealed: false, processSignaled: false, inOriginalJob: true,
        startupCompleted: false, lifecycleCompleted: false },
      beforeExplicitStop: { startupCompleted: true, completionCompleted: false, lifecycleCompleted: false, sameLifecycle: true },
      nodePin: { originalRetained: true, originalJoined: true, alive: false, exitCode: 0 },
      completed: { physicalCleanup: true, noPrepare: false, startupAccepted: true, startupTaskJoined: true,
        observationOwner: "service", explicitStop: true, workerStarts: 1,
        graceful: { verified: true, frameSent: true, forceCalls: 0 },
        cleanup: { rootExit: { exitCode: 0 }, treeExit: { activeProcesses: 0 },
          stdout: { eof: true, readFailureType: null, sinkFailureType: null },
          stderr: { eof: true, readFailureType: null, sinkFailureType: null } } },
    });
    expect(await readFile(join(directory, "service-stop-frame-received"), "utf8")).toBe("ZEB_WORKER_SHUTDOWN_V1\n");
  } else {
    expect(receipt).toMatchObject({
      outerTotalProcesses: 1, nodePin: null, noOwner: { noPrepare: true, workerStarts: 0 },
      completed: { noPrepare: true, physicalCleanup: false, workerStarts: 0 },
    });
  }
  process.stdout.write("[WINDOWS-SERVICE-STARTUP] " + JSON.stringify({ scenario, directory, passed: receipt.passed }) + "\n");
  return receipt;
}
windowsSuite.sequential(
  "Windows thin service host original containment",
  () => {
    beforeAll(async () => {
      if (process.platform !== "win32")
        throw new Error(
          "Windows service-host OS tests were explicitly selected on another platform.",
        );
      const suppliedFixture = process.env.ZEB_WINDOWS_SERVICE_HOST_FIXTURE_EXE;
      const suppliedProduct = process.env.ZEB_WINDOWS_SERVICE_HOST_EMPTY_EXE;
      if (
        !suppliedFixture ||
        !suppliedProduct ||
        !isAbsolute(suppliedFixture) ||
        !isAbsolute(suppliedProduct)
      )
        throw new Error(
          "Explicit published fixture and fixed-payload-empty product executable paths are required.",
        );
      fixture = resolve(suppliedFixture);
      emptyProduct = resolve(suppliedProduct);
      await Promise.all([access(fixture), access(emptyProduct), access(main)]);
      evidenceRoot =
        process.env.ZEB_WINDOWS_SERVICE_HOST_EVIDENCE_DIR ??
        (await mkdtemp(join(tmpdir(), "zeb-service-host-")));
      await mkdir(evidenceRoot, { recursive: true });
    });

    it.each([
      [
        "root-exit",
        "H1: a real Node root exits while its detached permanent hung descendant remains",
      ],
      [
        "host-death",
        "H2: only the retained host is terminated after all inner Job query handles close",
      ],
      [
        "stop-race",
        "H3: repeated stop shares cleanup while root exit races and a second start is rejected",
      ],
      [
        "sink-failure",
        "a real sink failure contains the tree and both original streams continue draining to EOF",
      ],
    ])(
      "%s: %s",
      async (scenario) => {
        const { caller, receipt } = await exercise(scenario);
        // This is intentionally first: StageT must fail on the real loaded core's Start, not a missing READY timeout.
        expect(
          receipt.start?.startSucceeded,
          `actual Start failed: ${receipt.start?.startFailureType}`,
        ).toBe(true);
        expectCaller(caller);
        expect(receipt.passed, receipt.failures.join("\n")).toBe(true);
        expect(receipt.failures).toEqual([]);
        expect(receipt.start).toMatchObject({
          authorized: true,
          completionCompleted: false,
        });
        expect(receipt.start!.jobHandleFlags! & 1).toBe(0);
        expect(receipt.start!.processHandleFlags! & 1).toBe(0);
        expect(receipt.beforeInjection).toMatchObject({
          hostAlive: true,
          rootAlive: true,
          hungAlive: true,
          queryHandlesClosedBeforeInjection: true,
          noMoreSpawnsAfterReady: true,
          initialCensus: { queryHandleClosed: true },
          census: { queryHandleClosed: true },
        });
        const before = receipt.beforeInjection!;
        const consolePins = receipt.cleanup.systemConsolePins!;
        expect(before.systemConsoleCount).toBe(before.systemConsolePins.length);
        expect(consolePins).toHaveLength(before.systemConsolePins.length);
        const pins = receipt.cleanup.pins!;
        const registered = [
          pins[1]!.identity,
          pins[2]!.identity,
          ...before.systemConsolePins.map((pin) => pin.identity),
        ];
        const memberIds = registered
          .map((identity) => identity.pid)
          .sort((a, b) => a - b);
        expect(new Set(memberIds).size).toBe(memberIds.length);
        expect(
          before.registeredInnerIdentities
            .slice()
            .sort((a, b) => a.pid - b.pid),
        ).toEqual(registered.slice().sort((a, b) => a.pid - b.pid));
        for (const census of [before.initialCensus, before.census]) {
          expect(census.memberIds.slice().sort((a, b) => a - b)).toEqual(
            memberIds,
          );
          expect(census.activeProcesses).toBe(memberIds.length);
          expect(census.totalProcesses).toBe(memberIds.length);
        }
        const completeProcessCount = 1 + memberIds.length;
        expect(receipt.cleanup).toMatchObject({
          guardianUsed: false,
          injectionOccurred: true,
          allPinsJoined: true,
          observedPins: completeProcessCount,
          expectedPins: completeProcessCount,
          principalExpectedPins: 3,
          principalObservedPins: 3,
          systemConsoleCount: consolePins.length,
          workerStarts: 1,
          safetyTreeExit: { activeProcesses: 0 },
          safetyAccounting: {
            activeProcesses: 0,
            totalProcesses: completeProcessCount,
            distinctFromHostOwnedJob: true,
          },
          stdout: { eof: true, errorType: null },
          stderr: { eof: true, errorType: null },
        });
        expect(pins).toHaveLength(3);
        for (const pin of pins) {
          expect(pin).toMatchObject({
            originalRetained: true,
            originalJoined: true,
            alive: false,
            independentCreationPin: false,
          });
          expect(pin.exitCode).not.toBeNull();
        }
        expect(pins[1]!.identity).toEqual(receipt.start!.root);
        expect(pins.map((pin) => pin.source)).toEqual([
          "qualified-post-open-query-pin",
          "qualified-post-open-query-pin",
          "original-descendant-self-process-object",
        ]);
        for (const [index, original] of before.systemConsolePins.entries()) {
          expect(original).toMatchObject({
            source:
              "original-job-census-qualified-post-open-system-console-pin",
            requestedAccess: 0x00101000,
            independentCreationPin: false,
            qualifiedSystemConsole: true,
            sameSid: true,
            nonInherited: true,
            inOriginalJobVerified: true,
            originalRetained: true,
            originalJoined: false,
            alive: true,
            signaled: false,
            exitCode: null,
          });
          expect(original.sid).toBe(pins[1]!.sid);
          expect(original.imagePath.toLowerCase()).toBe(
            original.expectedImagePath.toLowerCase(),
          );
          expect(original.imageIdentity).toBe(original.expectedImageIdentity);
          const final = consolePins[index]!;
          expect(final).toMatchObject({
            identity: original.identity,
            source: original.source,
            requestedAccess: original.requestedAccess,
            expectedImagePath: original.expectedImagePath,
            expectedImageIdentity: original.expectedImageIdentity,
            imagePath: original.imagePath,
            imageIdentity: original.imageIdentity,
            sid: original.sid,
            sameSid: true,
            qualifiedSystemConsole: true,
            nonInherited: true,
            inOriginalJobVerified: true,
            independentCreationPin: false,
            originalRetained: true,
            originalJoined: true,
            alive: false,
            signaled: true,
          });
          expect(final.exitCode).not.toBeNull();
        }
        if (scenario === "host-death") {
          expect(receipt.hostDeath).toEqual({
            intentionallyTerminatedHostOnly: true,
            queryHandlesClosedBeforeInjection: true,
            postCrashOriginalJobActiveProcesses: null,
            postCrashJobQueryUnavailable: true,
            originalHostCompletionObserved: false,
            originalHostTreeExitObserved: false,
            safetyJobStillOwned: true,
          });
          expect(receipt.completed).toBeUndefined();
          expect(pins[0]!.exitCode).toBe(137);
        } else {
          const cleanup = receipt.completed!.cleanup;
          expect(cleanup).toMatchObject({
            treeExit: { activeProcesses: 0 },
            stdout: { eof: true, readFailureType: null },
            stderr: { eof: true, readFailureType: null, sinkFailureType: null },
          });
          const rootExit = cleanup.rootExit as {
            identity: unknown;
            exitCode: number;
          };
          expect(rootExit.identity).toEqual(pins[1]!.identity);
          expect(rootExit.exitCode).toBe(pins[1]!.exitCode);
          if (scenario === "root-exit") {
            expect(rootExit.exitCode).toBe(0);
            expect(receipt.completed!.completionSucceeded).toBe(true);
          } else if (scenario === "stop-race") {
            expect(receipt.completed).toMatchObject({
              completionSucceeded: true,
              sameStopTask: true,
              secondStartRejected: true,
            });
          } else {
            expect(receipt.completed).toMatchObject({
              completionSucceeded: false,
              sinkThrows: 1,
            });
            expect(cleanup.stdout).toMatchObject({
              sinkFailureType: "IOException",
            });
          }
        }
      },
      testMs,
    );

    it.each(["graceful-cooperate", "graceful-ignore", "graceful-root-hung", "graceful-nonzero", "graceful-hard-stop", "graceful-sink-failure"])(
      "T3b: %s retains the original Job and first real thirty-second window",
      async (scenario) => {
        const { caller, receipt } = await exercise(scenario);
        expectCaller(caller);
        expect(receipt.start?.startSucceeded).toBe(true);
        expect(receipt.passed, receipt.failures.join("\n")).toBe(true);
        expect(receipt.cleanup).toMatchObject({ guardianUsed: false, injectionOccurred: true, allPinsJoined: true,
          workerStarts: 1, safetyTreeExit: { activeProcesses: 0 }, stdout: { eof: true, errorType: null }, stderr: { eof: true, errorType: null } });
        const before = receipt.beforeInjection!;
        expect(before.queryHandlesClosedBeforeInjection && before.noMoreSpawnsAfterReady).toBe(true);
        const principals = scenario === "graceful-cooperate" ? 2 : 3;
        const expectedInner = principals - 1 + before.systemConsoleCount;
        for (const census of [before.initialCensus, before.census]) {
          expect(census.queryHandleClosed).toBe(true);
          expect(census.activeProcesses).toBe(expectedInner);
          expect(census.totalProcesses).toBe(expectedInner);
          expect(census.memberIds.slice().sort((a, b) => a - b)).toEqual(before.registeredInnerIdentities.map((v) => v.pid).sort((a, b) => a - b));
        }
        expect(receipt.cleanup.principalObservedPins).toBe(principals);
        expect(receipt.cleanup.pins).toHaveLength(principals);
        for (const pin of receipt.cleanup.pins!) {
          expect(pin).toMatchObject({ originalRetained: true, originalJoined: true, alive: false, independentCreationPin: false });
          expect(pin.exitCode).not.toBeNull();
        }
        for (const pin of receipt.cleanup.systemConsolePins!)
          expect(pin).toMatchObject({ originalRetained: true, originalJoined: true, alive: false, qualifiedSystemConsole: true,
            nonInherited: true, sameSid: true, inOriginalJobVerified: true, independentCreationPin: false });
        const completed = receipt.completed!;
        const grace = completed.graceful as { selected: boolean; requestedTick: number; deadlineTick: number; frameWrites: number;
          frameSent: boolean; frameSentTick: number; hardPreempt: boolean; failure: string | null; forceCalls: number;
          forceTick: number | null; verified: boolean; ownerReleasedTreeActive: number; writeJoined: boolean };
        expect(completed).toMatchObject({ sameStopTask: true, repeatAnchorUnchanged: true,
          cleanup: { treeExit: { activeProcesses: 0 }, stdout: { eof: true, readFailureType: null }, stderr: { eof: true, readFailureType: null, sinkFailureType: null } } });
        expect(grace).toMatchObject({ selected: true, frameWrites: 1, writeJoined: true, ownerReleasedTreeActive: 0 });
        expect(grace.deadlineTick - grace.requestedTick).toBe(30_000);
        if (scenario === "graceful-cooperate") {
          expect(completed.completionSucceeded).toBe(true);
          expect(grace).toMatchObject({ frameSent: true, forceCalls: 0, forceTick: null, hardPreempt: false, failure: null, verified: true });
          expect(grace.frameSentTick).toBeLessThan(grace.deadlineTick);
          expect(receipt.cleanup.pins![1]!.exitCode).toBe(0);
        } else {
          expect(completed.completionSucceeded).toBe(false);
          expect(grace.forceCalls).toBe(1);
          expect(grace.verified).toBe(false);
          expect(grace.failure).not.toBeNull();
          if (scenario === "graceful-ignore" || scenario === "graceful-root-hung") {
            expect(completed.withinWindow).toMatchObject({ pending: true, forceCalls: 0, processSignaled: scenario === "graceful-root-hung" });
            const window = completed.withinWindow as { tick: number; activeProcesses: number };
            expect(window.tick).toBeGreaterThanOrEqual(grace.requestedTick + 28_000);
            expect(window.tick).toBeLessThan(grace.deadlineTick);
            expect(window.activeProcesses).toBeGreaterThan(0);
            expect(grace.failure).toBe("deadline");
            expect(grace.forceTick).toBeGreaterThanOrEqual(grace.deadlineTick);
          } else {
            expect(grace.hardPreempt).toBe(true);
            expect(grace.forceTick).toBeLessThan(grace.deadlineTick);
          }
          if (scenario === "graceful-nonzero") {
            expect(receipt.cleanup.pins![1]!.exitCode).toBe(23);
            expect(grace.failure).toBe("worker_nonzero");
          }
          if (scenario === "graceful-sink-failure") expect(completed.sinkThrows).toBe(1);
        }
      }, testMs,
    );

    it("T3b: graceful stop before start seals without Prepare, frame or Force", async () => {
      const { caller, receipt } = await exercise("graceful-before-start");
      expectCaller(caller);
      expect(receipt).toMatchObject({ passed: true, stopped: true, sameStopTask: true, secondStartRejected: true, workerStarts: 0,
        graceful: { selected: true, frameWrites: 0, frameSent: false, forceCalls: 0, verified: false },
        boundary: { guardianUsed: false, accounting: { activeProcesses: 0, totalProcesses: 1 }, safetyTreeExit: { activeProcesses: 0 } } });
    }, testMs);

    it(
      "H3: stop before start admits no Node or second generation",
      async () => {
        const { caller, receipt } = await exercise("stop-before-start");
        expectCaller(caller);
        expect(receipt).toMatchObject({
          passed: true,
          failures: [],
          stopped: true,
          sameStopTask: true,
          secondStartRejected: true,
          workerStarts: 0,
        });
        expect(receipt.cleanup).toMatchObject({
          rootExit: null,
          treeExit: null,
          stdout: { eof: false, bytesRead: 0 },
          stderr: { eof: false, bytesRead: 0 },
        });
        expect(receipt.boundary).toMatchObject({
          guardianUsed: false,
          originalChild: {
            source: "qualified-post-open-query-pin",
            originalRetained: true,
            originalJoined: true,
            alive: false,
            exitCode: 0,
          },
          accounting: { activeProcesses: 0, totalProcesses: 1 },
          safetyTreeExit: { activeProcesses: 0 },
          stdout: { eof: true, errorType: null },
          stderr: { eof: true, bytesRead: 0, errorType: null },
        });
        expect(
          JSON.parse(
            await readFile(
              join(caller.directory, "stop-before-start-child-evidence.json"),
              "utf8",
            ),
          ),
        ).toEqual(receipt.child);
      },
      testMs,
    );

    it(
      "missing fixed payload fails before Prepare with a path-free diagnostic",
      async () => {
        const directory = await mkdtemp(
          join(evidenceRoot, "missing-fixed-payload-"),
        );
        const caller = await capture(
          fixture,
          [
            "product-empty",
            emptyProduct,
            directory,
            String(executionMs),
            String(cleanupMs),
          ],
          directory,
        );
        expectCaller(caller);
        const receipt = JSON.parse(
          Buffer.from(caller.stdoutBase64, "base64").toString("utf8"),
        ) as Receipt;
        expect(
          JSON.parse(
            await readFile(
              join(directory, "service-host-evidence.json"),
              "utf8",
            ),
          ),
        ).toEqual(receipt);
        expect(receipt).toMatchObject({
          passed: true,
          failures: [],
          product: {
            exitCode: 2,
            activeProcesses: 0,
            totalProcesses: 1,
            zeroChildStarts: true,
            stdout: { eof: true, bytesRead: 0, errorType: null },
            stderr: { eof: true, errorType: null },
          },
          cleanup: { guardianUsed: false },
        });
        const stderr = (receipt.product as Value).stderr as Value;
        expect(
          Buffer.from(stderr.utf8Base64 as string, "base64")
            .toString("utf8")
            .trim(),
        ).toBe("worker_payload_unavailable");
      },
      testMs,
    );
    it.each(["allow", "deny-parent", "deny-grandparent", "missing-store", "relative-store", "wrong-leaf", "unc-store", "reparse-ancestor"])(
      "startup ancestors: %s is checked before any worker process is created",
      async (scenario) => {
        const directory = await mkdtemp(join(evidenceRoot, "startup-"));
        const version = join(directory, "program", "v1");
        await cp(dirname(emptyProduct), version, { recursive: true, errorOnExist: true, force: false });
        await mkdir(join(version, "runtime"));
        await mkdir(join(version, "app"));
        await cp(process.execPath, join(version, "runtime", "node.exe"));
        const marker = join(directory, "worker-started.txt");
        await writeFile(join(version, "app", "main.mjs"), `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)}, 'started', {flag:'wx'});`);
        const external = join(directory, "external");
        await mkdir(join(external, "nested", "data", "store"), { recursive: true });
        let store: unknown = join(external, "nested", "data", "store");
        if (scenario === "missing-store") store = undefined;
        if (scenario === "relative-store") store = "data/store";
        if (scenario === "wrong-leaf") store = join(external, "nested", "data", "records");
        if (scenario === "unc-store") store = "\\\\localhost\\C$\\data\\store";
        if (scenario === "reparse-ancestor") {
          const link = join(directory, "linked-external");
          await symlink(external, link, "junction");
          store = join(link, "nested", "data", "store");
        }
        await writeFile(join(version, "app", "worker.config.json"), JSON.stringify({ storeDirectory: store }));
        const caller = await capture(fixture, ["product-startup", join(version, "WindowsServiceHost.exe"), directory,
          String(executionMs), String(cleanupMs), scenario], directory);
        expectCaller(caller);
        const receipt = JSON.parse(Buffer.from(caller.stdoutBase64, "base64").toString("utf8")) as Receipt;
        expect(receipt.passed, receipt.failures.join("\n")).toBe(true);
        expect(receipt.cleanup.guardianUsed).toBe(false);
        const allowed = scenario === "allow";
        expect(receipt.product).toMatchObject({ exitCode: allowed ? 0 : 1, activeProcesses: 0, zeroChildStarts: !allowed });
        if (allowed) expect((receipt.product as Value).totalProcesses).toBeGreaterThan(1);
        else expect((receipt.product as Value).totalProcesses).toBe(1);
        expect(await access(marker).then(() => true, () => false)).toBe(allowed);
        if (scenario.startsWith("deny-")) {
          expect(receipt.externalUnchanged).toBe(true);
          expect(receipt.parentRestored).toBe(true);
        }
      }, testMs,
    );

    it("service startup schedule returns while the unique original start is held at ACK", async () => {
      const receipt = await exerciseServiceStartup("schedule");
      expect(receipt).toMatchObject({ startReturned: { startFailureType: null }, completed: { startFailureType: null } });
    }, testMs);

    it("service startup lifecycle covers early Stop, pre-start validation and post-authorize observation failure", async () => {
      for (const scenario of ["early-stop", "validation-before-start", "post-authorize-disconnect"] as const) {
        const receipt = await exerciseServiceStartup(scenario);
        if (scenario === "early-stop") expect(receipt).toMatchObject({
          noOwner: { startFailureType: "InvalidOperationException" },
          completed: { earlyOnStopInvoked: true, lateStartRejected: true },
        });
        if (scenario === "validation-before-start") expect(receipt).toMatchObject({
          noOwner: { startFailureType: "InvalidDataException" },
          completed: { startupAccepted: true, startupTaskJoined: true, observationOwner: "service",
            startFailureType: "InvalidDataException" },
        });
        if (scenario === "post-authorize-disconnect") expect(receipt).toMatchObject({
          disconnectRaceTargetReached: true,
          startReturned: { startFailureType: "IOException", capture: { failureType: "IOException",
            firstFailureRetained: true, failureStage: "write-authorized", ackValidated: true,
            authorizationMayHaveOccurred: true, authorizedWriteReturned: false } },
          completed: { startFailureType: "IOException" },
        });
      }
    }, testMs);
    it.each([
      "ack", "wrong-nonce", "wrong-attempt", "wrong-sha",
      "wrong-host-creation", "wrong-node-creation", "half-ack", "overlong-ack",
      "eof", "no-ack", "stop-before-ack", "ordinary", "service-policy",
      "post-authorize-disconnect",
    ] as const)(
      "startup observation: %s retains the original Prepared/ACK boundary",
      async (scenario) => {
        const directory = await mkdtemp(join(evidenceRoot, "startup-observation-" + scenario + "-"));
        const caller = await capture(fixture, [
          "startup-observation-case", scenario, directory, process.execPath, startupMain,
          String(5_000), String(5_000),
        ], directory);
        expectCaller(caller);
        const receipt = JSON.parse(
          Buffer.from(caller.stdoutBase64, "base64").toString("utf8"),
        ) as Value;
        expect(JSON.parse(
          await readFile(join(directory, "service-host-evidence.json"), "utf8"),
        )).toEqual(receipt);
        if (scenario === "service-policy") {
          expect(receipt).toEqual({
            passed: true, scenario, technicalSameUser: true,
            scope: "negative production principal gate only; no SCM or production service token exercised",
          });
          return;
        }
        expect(receipt).toMatchObject({
          scenario, passed: true, failures: [], technicalSameUser: true,
          crossSidScmAccepted: false, guardianUsed: false, originalsJoined: true,
          safetyTree: { activeProcesses: 0 },
          hostStdout: { eof: true, errorType: null },
          hostStderr: { eof: true, errorType: null },
          completed: {
            physicalCleanup: true, secondStartRejected: true, technicalSameUser: true,
            workerStarts: scenario === "ack" || scenario === "ordinary" || scenario === "post-authorize-disconnect" ? 1 : 0,
            cleanup: {
              treeExit: { activeProcesses: 0 },
              stdout: { eof: true, readFailureType: null, sinkFailureType: null },
              stderr: { eof: true, readFailureType: null, sinkFailureType: null },
            },
          },
        });
        const completed = receipt.completed as Value;
        expect((completed.cleanup as Value).rootExit).toMatchObject({ exitCode: expect.any(Number) });
        if (scenario === "post-authorize-disconnect") expect(receipt).toMatchObject({
          disconnectRaceTargetReached: true,
          postAuthorizationAlive: { workerStarts: 1, beforeExplicitStop: true },
          startReturned: {
            startFailureType: "IOException", completionBeforeExplicitStop: false,
            capture: {
              failureType: "IOException", firstFailureRetained: true,
              stage: "write-authorized", failureStage: "write-authorized",
              preparedWriteReturned: true, ackValidated: true,
              authorizationMayHaveOccurred: true, authorizedWriteReturned: false,
            },
          },
        });
        if (scenario === "ordinary") {
          expect(receipt.prepared).toBeUndefined();
          expect(receipt.beforeAck).toBeUndefined();
          expect(receipt.authorized).toBeUndefined();
          expect(completed.startFailureType).toBeNull();
        } else {
          expect(receipt.beforeAck).toMatchObject({ markerAbsent: true });
          if (scenario === "ack") expect(receipt.authorized).toMatchObject({
            kind: "authorized", seq: 3, authorized: true,
          });
          else expect(receipt.authorized).toBeUndefined();
        }
      }, testMs,
    );
  },
);
