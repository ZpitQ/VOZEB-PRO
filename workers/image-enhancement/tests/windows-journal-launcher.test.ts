import { constants as bufferConstants } from "node:buffer";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { win32 } from "node:path";
import { PassThrough, Writable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createWindowsJournalLauncher,
  type WindowsJournalLauncher,
  type WindowsJournalReadResult,
} from "../src/windows-journal-launcher.js";
import {
  freezeWindowsJournalReadContext,
  interpretWindowsJournalSnapshot,
} from "../src/windows-journal-reader.js";
import { journalLauncherFixture } from "./windows-journal-launcher-fixtures.js";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

type Options = Parameters<typeof createWindowsJournalLauncher>[0];
type Fixture = ReturnType<typeof journalLauncherFixture>;
type ObjectValue = Record<string, unknown>;

// Explicit test policy only; these are not suggested deployment defaults.
const testLimits = {
  maxRequestBytes: 32_768,
  maxStdoutBytes: 1_048_576,
  maxStderrBytes: 1_024,
  readTimeoutMs: 1_000,
  cleanupTimeoutMs: 100,
};
const syntheticFailureText = "synthetic-private-reader-error";

function options(overrides: Partial<Options> = {}): Options {
  return {
    executablePath: "Z:\\contract-only\\读取 reader's folder\\reader.exe",
    recordsRoot: "Z:\\contract-only\\journal's records 🪑",
    environment: { SYNTHETIC_READER_VALUE: "fixture-only 🪑" },
    limits: { ...testLimits },
    ...overrides,
  };
}

function responseBytes(snapshot: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(snapshot)}\n`, "utf8");
}

function unknownSnapshot(): unknown {
  const unknown = () => ({ status: "unknown", snapshot: null });
  return {
    v: 1,
    kind: "windows-journal-snapshot",
    reservation: unknown(),
    records: {
      request: unknown(),
      prepared: unknown(),
      authorization: unknown(),
      controllerLoss: unknown(),
      terminal: unknown(),
    },
  };
}

function requestBytes(fixture: Fixture): Buffer {
  return responseBytes({
    v: 1,
    kind: "read-windows-journal",
    scope: fixture.scope,
    executionId: fixture.descriptor.executionId,
  });
}

function objectAt(value: unknown, ...path: string[]): ObjectValue {
  for (const key of path) value = (value as ObjectValue)[key];
  return value as ObjectValue;
}

function setData(value: object, key: string, replacement: unknown): void {
  Object.defineProperty(value, key, {
    value: replacement,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function expectDeepFrozen(value: unknown): void {
  if (!value || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

function expectRead(result: WindowsJournalReadResult) {
  expect(result.kind).toBe("read");
  if (result.kind !== "read") throw new Error("expected a read result");
  expect(result.cleanup).toBe("closed");
  expectDeepFrozen(result);
  return result;
}

function expectUnknown(
  result: WindowsJournalReadResult,
  cleanup: "closed" | "unknown",
): void {
  expect(result).toEqual({ kind: "unknown", cleanup });
  expect(Object.isFrozen(result)).toBe(true);
  expect(JSON.stringify(result)).not.toContain(syntheticFailureText);
}

function read(
  launcher: WindowsJournalLauncher,
  fixture = journalLauncherFixture(),
  signal = new AbortController().signal,
  stillCurrent: () => boolean = () => true,
): Promise<WindowsJournalReadResult> {
  return launcher.read(fixture.scope, fixture.descriptor, signal, stillCurrent);
}

// One event-loop checkpoint, not a polling loop or a timing assertion.
async function flushEvents(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

type SyntheticChild = EventEmitter & {
  stdin: Writable;
  stdout: PassThrough;
  stderr: PassThrough;
  stdio: [Writable, PassThrough, PassThrough];
  pid: number | undefined;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: boolean;
  kill: ReturnType<typeof vi.fn<() => boolean>>;
};

type InjectedReader = {
  child: SyntheticChild;
  input: Buffer[];
  inputEof: boolean;
  complete(): void;
  exit(code?: number | null, signal?: NodeJS.Signals | null): void;
};

type Scenario = {
  body?: Buffer;
  chunks?: readonly Buffer[];
  stderr?: Buffer;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  autoComplete?: boolean;
  onFirstInput?: (reader: InjectedReader) => void;
  onInputFinished?: (reader: InjectedReader) => void;
};

const injectedReaders: InjectedReader[] = [];

// A byte-protocol seam and an injected event-order seam, never OS evidence.
// Streams are real Node streams. Only the original synthetic ChildProcess events
// are controlled here. Real abort/deadline/flood/process evidence is in os.test.ts.
function installReader(scenario: Scenario = {}): InjectedReader {
  const child = new EventEmitter() as SyntheticChild;
  const input: Buffer[] = [];
  const closed = new Set<string>();
  let exited = false;
  let childClosed = false;
  let completed = false;
  let reader: InjectedReader;
  const maybeClose = () => {
    if (exited && closed.size === 3 && !childClosed) {
      childClosed = true;
      queueMicrotask(() =>
        child.emit("close", child.exitCode, child.signalCode),
      );
    }
  };
  child.stdin = new Writable({
    autoDestroy: true,
    write(chunk: Buffer, _encoding, callback) {
      input.push(Buffer.from(chunk));
      if (input.length === 1) scenario.onFirstInput?.(reader);
      callback();
    },
    final(callback) {
      reader.inputEof = true;
      callback();
      queueMicrotask(() => {
        scenario.onInputFinished?.(reader);
        if (scenario.autoComplete !== false) reader.complete();
      });
    },
  });
  child.stdout = new PassThrough({ autoDestroy: true });
  child.stderr = new PassThrough({ autoDestroy: true });
  child.stdio = [child.stdin, child.stdout, child.stderr];
  child.pid = 12_001;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  for (const [name, stream] of [
    ["stdin", child.stdin],
    ["stdout", child.stdout],
    ["stderr", child.stderr],
  ] as const) {
    stream.on("close", () => {
      closed.add(name);
      maybeClose();
    });
  }
  reader = {
    child,
    input,
    inputEof: false,
    exit(code = 0, signal = null) {
      exited = true;
      child.exitCode = code;
      child.signalCode = signal;
      child.emit("exit", code, signal);
      maybeClose();
    },
    complete() {
      if (completed) return;
      completed = true;
      if (!child.stdin.writableEnded) child.stdin.end();
      if (scenario.chunks) {
        for (const bytes of scenario.chunks) child.stdout.write(bytes);
        child.stdout.end();
      } else {
        child.stdout.end(
          scenario.body ?? responseBytes(journalLauncherFixture().snapshot),
        );
      }
      child.stderr.end(scenario.stderr);
      reader.exit(
        scenario.exitCode === undefined ? 0 : scenario.exitCode,
        scenario.signal ?? null,
      );
    },
  };
  injectedReaders.push(reader);
  spawnMock.mockImplementationOnce(() => {
    queueMicrotask(() => child.emit("spawn"));
    return child as unknown as ChildProcess;
  });
  return reader;
}

async function expireReadAndCleanup(): Promise<void> {
  await vi.advanceTimersByTimeAsync(
    testLimits.readTimeoutMs + testLimits.cleanupTimeoutMs,
  );
  await flushEvents();
}

describe.runIf(process.platform === "win32")(
  "Windows journal launcher contract",
  () => {
    beforeEach(() => {
      spawnMock.mockReset();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });

    afterEach(() => {
      // Dispose only injected test resources. These closes are never asserted as
      // proof of reader EOF or production cleanup.
      for (const reader of injectedReaders.splice(0)) {
        reader.child.stdin.destroy();
        reader.child.stdout.destroy();
        reader.child.stderr.destroy();
      }
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it("reads a complete synthetic snapshot after the original transport gate closes", async () => {
      const fixture = journalLauncherFixture();
      const original = installReader({ body: responseBytes(fixture.snapshot) });
      const result = expectRead(
        await read(createWindowsJournalLauncher(options()), fixture),
      );
      expect(result.interpretation.kind).toBe("engine-exit");
      expect(result.interpretation).toEqual(
        interpretWindowsJournalSnapshot(
          fixture.snapshot,
          fixture.scope,
          fixture.descriptor,
        ),
      );
      expect(original.inputEof).toBe(true);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(original.child.kill).not.toHaveBeenCalled();
    });

    it.each(["stop", "deadline"] as const)(
      "passes resumed %s through the original closed transport gate",
      async (kind) => {
        const fixture = journalLauncherFixture();
        setData(
          objectAt(
            fixture.snapshot,
            "records",
            "terminal",
            "snapshot",
            "record",
          ),
          "completion",
          { kind },
        );
        const original = installReader({
          body: responseBytes(fixture.snapshot),
        });
        const result = expectRead(
          await read(createWindowsJournalLauncher(options()), fixture),
        );
        expect(result.interpretation).toEqual({
          kind,
          exit: {
            identity: fixture.scope.target.identity,
            descriptor: fixture.descriptor,
            launchTicket: fixture.scope.target.launchTicket,
            treeExited: true,
          },
        });
        if (result.interpretation.kind !== kind)
          throw new Error("qualified stopped tree required");
        expect(Object.hasOwn(result.interpretation.exit, "completion")).toBe(
          false,
        );
        expect(original.inputEof).toBe(true);
        expect(spawnMock).toHaveBeenCalledTimes(1);
        expect(original.child.kill).not.toHaveBeenCalled();
      },
    );

    it("returns a legal read when a complete ordinary-shaped response interprets as Unknown", async () => {
      installReader({ body: responseBytes(unknownSnapshot()) });
      const result = expectRead(
        await read(createWindowsJournalLauncher(options())),
      );
      expect(result.interpretation).toEqual({ kind: "unknown" });
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    it("sends exactly one UTF8 request and EOF with the fixed argv, cwd, pipes and explicit environment", async () => {
      const fixture = journalLauncherFixture();
      setData(
        fixture.scope.target.identity,
        "jobId",
        'launcher-输入 🪑 "quoted" \\ job',
      );
      setData(
        fixture.descriptor.details,
        "target",
        structuredClone(fixture.scope.target),
      );
      const original = installReader({
        body: responseBytes(unknownSnapshot()),
      });
      const configured = options();
      expectRead(await read(createWindowsJournalLauncher(configured), fixture));
      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [executable, argv, spawnOptions] = spawnMock.mock.calls[0]!;
      expect(executable).toBe(configured.executablePath);
      expect(argv).toEqual(["--read-records", configured.recordsRoot]);
      expect(["pipe", ["pipe", "pipe", "pipe"]]).toContainEqual(
        (spawnOptions as SpawnOptions).stdio,
      );
      expect(spawnOptions).toEqual({
        cwd: win32.dirname(configured.executablePath),
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: false,
        detached: true,
        stdio: (spawnOptions as SpawnOptions).stdio,
        env: configured.environment,
      });
      expect(Object.isFrozen((spawnOptions as SpawnOptions).env)).toBe(true);
      expect(Buffer.concat(original.input)).toEqual(requestBytes(fixture));
      expect(Buffer.concat(original.input).byteLength).toBeGreaterThan(
        Buffer.concat(original.input).toString("utf8").length,
      );
      expect(original.inputEof).toBe(true);
      expect(
        Object.keys(JSON.parse(Buffer.concat(original.input).toString("utf8"))),
      ).toEqual(["v", "kind", "scope", "executionId"]);
    });

    it("registers child and all stream lifecycle handlers before the first input write", async () => {
      let handlers: boolean[] = [];
      installReader({
        onFirstInput({ child }) {
          handlers = [
            ...["error", "exit", "close"].map(
              (event) => child.listenerCount(event) > 0,
            ),
            ...["error", "finish"].map(
              (event) => child.stdin.listenerCount(event) > 0,
            ),
            child.stdin.listenerCount("close") > 1,
            ...[child.stdout, child.stderr].flatMap((stream) => [
              ...["error", "end"].map(
                (event) => stream.listenerCount(event) > 0,
              ),
              stream.listenerCount("data") > 0 ||
                stream.listenerCount("readable") > 0,
              stream.listenerCount("close") > 1,
            ]),
          ];
        },
      });
      expectRead(await read(createWindowsJournalLauncher(options())));
      expect(handlers.length).toBeGreaterThan(0);
      expect(handlers.every(Boolean)).toBe(true);
    });

    it("copies deployment environment and limits before the caller can mutate them", async () => {
      const environment = { SYNTHETIC_READER_VALUE: "original-value" };
      const limits = { ...testLimits };
      const launcher = createWindowsJournalLauncher(
        options({ environment, limits }),
      );
      environment.SYNTHETIC_READER_VALUE = "mutated-value";
      limits.maxStdoutBytes = 1;
      installReader();
      expectRead(await read(launcher));
      expect((spawnMock.mock.calls[0]![2] as SpawnOptions).env).toEqual({
        SYNTHETIC_READER_VALUE: "original-value",
      });
    });

    it("copies the original scope and descriptor synchronously at admission", async () => {
      const fixture = journalLauncherFixture();
      const expectedContext = structuredClone(fixture);
      const original = installReader({ body: responseBytes(fixture.snapshot) });
      const pending = read(createWindowsJournalLauncher(options()), fixture);
      setData(fixture.scope.target.identity, "fence", 99);
      setData(fixture.descriptor, "executionId", "f".repeat(32));
      const result = expectRead(await pending);
      expect(result.interpretation).toEqual(
        interpretWindowsJournalSnapshot(
          expectedContext.snapshot,
          expectedContext.scope,
          expectedContext.descriptor,
        ),
      );
      expect(Buffer.concat(original.input)).toEqual(
        requestBytes(expectedContext),
      );
    });

    it("accepts the exact request byte cap including its LF", async () => {
      const fixture = journalLauncherFixture();
      installReader({ body: responseBytes(fixture.snapshot) });
      expectRead(
        await read(
          createWindowsJournalLauncher(
            options({
              limits: {
                ...testLimits,
                maxRequestBytes: requestBytes(fixture).length,
              },
            }),
          ),
          fixture,
        ),
      );
    });

    it("rejects a request one byte over budget before spawn", async () => {
      const fixture = journalLauncherFixture();
      expectUnknown(
        await read(
          createWindowsJournalLauncher(
            options({
              limits: {
                ...testLimits,
                maxRequestBytes: requestBytes(fixture).length - 1,
              },
            }),
          ),
          fixture,
        ),
        "closed",
      );
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it("accepts a multibyte response at its exact byte cap even when a UTF8 scalar spans chunks", async () => {
      const body = responseBytes(journalLauncherFixture().snapshot);
      const scalar = body.indexOf(Buffer.from("输入", "utf8"));
      expect(scalar).toBeGreaterThan(-1);
      installReader({
        chunks: [body.subarray(0, scalar + 1), body.subarray(scalar + 1)],
      });
      expectRead(
        await read(
          createWindowsJournalLauncher(
            options({
              limits: { ...testLimits, maxStdoutBytes: body.length },
            }),
          ),
        ),
      );
    });

    it("rejects a response one byte over the stdout cap including LF", async () => {
      const body = responseBytes(journalLauncherFixture().snapshot);
      installReader({ body });
      const pending = read(
        createWindowsJournalLauncher(
          options({
            limits: { ...testLimits, maxStdoutBytes: body.length - 1 },
          }),
        ),
      );
      await expireReadAndCleanup();
      expectUnknown(await pending, "closed");
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    const validDocument = JSON.stringify(journalLauncherFixture().snapshot);
    const invalidWire: readonly [string, Buffer][] = [
      ["invalid UTF8", Buffer.from([0xc3, 0x28, 0x0a])],
      ["missing final LF", Buffer.from(validDocument)],
      ["two final LFs", Buffer.from(`${validDocument}\n\n`)],
      ["CRLF", Buffer.from(`${validDocument}\r\n`)],
      ["leading whitespace", Buffer.from(` ${validDocument}\n`)],
      ["trailing whitespace", Buffer.from(`${validDocument} \n`)],
      [
        "raw interior LF",
        Buffer.from(`${validDocument.replace('{"v":1,', '{\n"v":1,')}\n`),
      ],
      ["second JSON value", Buffer.from(`${validDocument}{}\n`)],
      ["bytes after LF", Buffer.from(`${validDocument}\n{}`)],
      ["comments", Buffer.from(`/*synthetic*/${validDocument}\n`)],
      ["trailing comma", Buffer.from(`${validDocument.slice(0, -1)},}\n`)],
      [
        "top-level decoded duplicate key",
        Buffer.from(
          `${validDocument.replace('{"v":1,', '{"v":1,"\\u0076":1,')}\n`,
        ),
      ],
      [
        "nested decoded duplicate key",
        Buffer.from(
          `${validDocument.replace('"status":"existing"', '"status":"existing","\\u0073tatus":"existing"')}\n`,
        ),
      ],
      [
        "deep decoded duplicate key",
        Buffer.from(
          `${validDocument.replace('"treeExited":true', '"treeExited":true,"\\u0074reeExited":true')}\n`,
        ),
      ],
      ["array document", Buffer.from("[]\n")],
      ["null document", Buffer.from("null\n")],
    ];

    it.each(invalidWire)(
      "rejects strict wire failure: %s",
      async (_name, body) => {
        installReader({ body });
        const pending = read(createWindowsJournalLauncher(options()));
        await expireReadAndCleanup();
        expectUnknown(await pending, "closed");
        expect(spawnMock).toHaveBeenCalledTimes(1);
      },
    );

    it("accepts strict JSON with a safe integer spelled in exponent notation", async () => {
      installReader({
        body: Buffer.from(`${validDocument.replace('{"v":1,', '{"v":1e0,')}\n`),
      });
      expect(
        expectRead(await read(createWindowsJournalLauncher(options())))
          .interpretation.kind,
      ).toBe("engine-exit");
    });

    it.each([
      ["negative zero", "-0"],
      ["unsafe integer", "9007199254740992"],
    ])(
      "preserves interpreter Unknown for a syntactically valid object with %s",
      async (_name, numeric) => {
        const snapshot = JSON.parse(
          validDocument.replace(
            '"activeProcesses":0',
            `"activeProcesses":${numeric}`,
          ),
        ) as unknown;
        const fixture = journalLauncherFixture();
        expect(
          interpretWindowsJournalSnapshot(
            snapshot,
            fixture.scope,
            fixture.descriptor,
          ),
        ).toEqual({ kind: "unknown" });
        installReader({
          body: Buffer.from(
            `${validDocument.replace('"activeProcesses":0', `"activeProcesses":${numeric}`)}\n`,
          ),
        });
        expect(
          expectRead(await read(createWindowsJournalLauncher(options())))
            .interpretation,
        ).toEqual({ kind: "unknown" });
      },
    );

    it.each([
      ["stderr byte", { stderr: Buffer.from("x") }],
      ["nonzero exit", { exitCode: 9 }],
      ["signal exit", { exitCode: null, signal: "SIGTERM" as const }],
    ])(
      "rejects a complete-looking response with %s",
      async (_name, scenario) => {
        installReader(scenario);
        const pending = read(createWindowsJournalLauncher(options()));
        await expireReadAndCleanup();
        expectUnknown(await pending, "closed");
        expect(spawnMock).toHaveBeenCalledTimes(1);
      },
    );

    it("does not spawn for invalid context and never executes a context accessor", async () => {
      const fixture = journalLauncherFixture();
      const getter = vi.fn(() => {
        throw new Error(syntheticFailureText);
      });
      Object.defineProperty(fixture.descriptor.details, "engine", {
        enumerable: true,
        get: getter,
      });
      expectUnknown(
        await read(createWindowsJournalLauncher(options()), fixture),
        "closed",
      );
      expect(getter).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it("does not spawn for a pre-aborted signal", async () => {
      const controller = new AbortController();
      controller.abort();
      expectUnknown(
        await read(
          createWindowsJournalLauncher(options()),
          undefined,
          controller.signal,
        ),
        "closed",
      );
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it.each([false, "throw"] as const)(
      "does not spawn when the admission guard is %s",
      async (behavior) => {
        const guard = () => {
          if (behavior === "throw") throw new Error(syntheticFailureText);
          return false;
        };
        expectUnknown(
          await read(
            createWindowsJournalLauncher(options()),
            undefined,
            undefined,
            guard,
          ),
          "closed",
        );
        expect(spawnMock).not.toHaveBeenCalled();
      },
    );

    it.each(["stale", "throw", "abort"] as const)(
      "rechecks %s after spawn and before input",
      async (behavior) => {
        const controller = new AbortController();
        let spawned = false;
        const original = installReader({ autoComplete: false });
        original.child.kill.mockImplementation(() => {
          original.complete();
          return true;
        });
        spawnMock.mockReset();
        spawnMock.mockImplementationOnce(() => {
          spawned = true;
          if (behavior === "abort") controller.abort();
          queueMicrotask(() => original.child.emit("spawn"));
          return original.child as unknown as ChildProcess;
        });
        const guard = () => {
          if (spawned && behavior === "throw")
            throw new Error(syntheticFailureText);
          return !(spawned && behavior === "stale");
        };
        const pending = read(
          createWindowsJournalLauncher(options()),
          undefined,
          controller.signal,
          guard,
        );
        await expireReadAndCleanup();
        expectUnknown(await pending, "closed");
        expect(Buffer.concat(original.input).length).toBe(0);
        expect(original.child.kill).toHaveBeenCalledTimes(1);
      },
    );

    it("rechecks currentness immediately before returning interpretation", async () => {
      let current = true;
      installReader({
        onInputFinished() {
          current = false;
        },
      });
      const pending = read(
        createWindowsJournalLauncher(options()),
        undefined,
        undefined,
        () => current,
      );
      await expireReadAndCleanup();
      expectUnknown(await pending, "closed");
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    it("admits synchronously and returns frozen Unknown to a busy caller without another child", async () => {
      const original = installReader({ autoComplete: false });
      const launcher = createWindowsJournalLauncher(options());
      const first = read(launcher);
      expectUnknown(await read(launcher), "unknown");
      expect(spawnMock).toHaveBeenCalledTimes(1);
      original.complete();
      expectRead(await first);
    });

    it("retains an owner after exit without actual stdout EOF and releases only after late EOF", async () => {
      const original = installReader({ autoComplete: false });
      const launcher = createWindowsJournalLauncher(options());
      const pending = read(launcher);
      let settlements = 0;
      void pending.then(() => settlements++);
      await flushEvents();
      original.child.stdout.write(
        responseBytes(journalLauncherFixture().snapshot),
      );
      original.child.stderr.end();
      original.exit();
      await flushEvents();
      expect(settlements).toBe(0);
      await expireReadAndCleanup();
      const failed = await pending;
      expectUnknown(failed, "unknown");
      expectUnknown(await read(launcher), "unknown");
      expect(spawnMock).toHaveBeenCalledTimes(1);
      original.child.stdout.end();
      await flushEvents();
      installReader();
      expectRead(await read(launcher));
      expect(spawnMock).toHaveBeenCalledTimes(2);
      expectUnknown(failed, "unknown");
      expect(settlements).toBe(1);
      expect(await launcher.close()).toBe("closed");
    });

    it("does not count a locally destroyed stdout close as actual output end", async () => {
      const original = installReader({ autoComplete: false });
      const launcher = createWindowsJournalLauncher(options());
      const pending = read(launcher);
      await flushEvents();
      original.child.stdout.write(
        responseBytes(journalLauncherFixture().snapshot),
      );
      original.child.stdout.destroy();
      original.child.stderr.end();
      original.exit();
      await expireReadAndCleanup();
      expectUnknown(await pending, "unknown");
      expectUnknown(await read(launcher), "unknown");
      const closing = launcher.close();
      await vi.advanceTimersByTimeAsync(testLimits.cleanupTimeoutMs);
      expect(await closing).toBe("unknown");
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    it("seals idle admission and shares the first close promise", async () => {
      const launcher = createWindowsJournalLauncher(options());
      const closing = launcher.close();
      expect(launcher.close()).toBe(closing);
      expect(await closing).toBe("closed");
      expectUnknown(await read(launcher), "closed");
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it("shares an active close deadline and never treats killed=true as exit", async () => {
      const original = installReader({ autoComplete: false });
      const launcher = createWindowsJournalLauncher(options());
      const pending = read(launcher);
      const closing = launcher.close();
      let closed = false;
      void closing.then(() => {
        closed = true;
      });
      await vi.advanceTimersByTimeAsync(testLimits.cleanupTimeoutMs - 1);
      expect(launcher.close()).toBe(closing);
      expect(closed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await closing).toBe("unknown");
      expectUnknown(await pending, "unknown");
      expect(original.child.killed).toBe(true);
      expect(original.child.kill).toHaveBeenCalledTimes(1);
      expectUnknown(await read(launcher), "unknown");
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    it.each(["returns false", "throws"] as const)(
      "retains the exact owner when original child.kill %s",
      async (behavior) => {
        const original = installReader({ autoComplete: false });
        original.child.kill.mockImplementation(() => {
          if (behavior === "throws") throw new Error(syntheticFailureText);
          return false;
        });
        const globalKill = vi.spyOn(process, "kill").mockImplementation(() => {
          throw new Error("global process kill is forbidden by this test");
        });
        const launcher = createWindowsJournalLauncher(options());
        const pending = read(launcher);
        await expireReadAndCleanup();
        expectUnknown(await pending, "unknown");
        expectUnknown(await read(launcher), "unknown");
        expect(spawnMock).toHaveBeenCalledTimes(1);
        expect(globalKill).not.toHaveBeenCalled();
        original.complete();
        await flushEvents();
        expect(await launcher.close()).toBe("closed");
      },
    );

    it("keeps a synchronous spawn throw as unresolved creation and does not retry", async () => {
      spawnMock.mockImplementationOnce(() => {
        throw new Error(syntheticFailureText);
      });
      const launcher = createWindowsJournalLauncher(options());
      const pending = read(launcher);
      await expireReadAndCleanup();
      expectUnknown(await pending, "unknown");
      expectUnknown(await read(launcher), "unknown");
      expect(spawnMock).toHaveBeenCalledTimes(1);
      const closing = launcher.close();
      await vi.advanceTimersByTimeAsync(testLimits.cleanupTimeoutMs);
      expect(await closing).toBe("unknown");
    });

    it("keeps error-before-spawn with undefined pid and partial closes poisoned", async () => {
      const original = installReader({ autoComplete: false });
      original.child.pid = undefined;
      spawnMock.mockReset();
      spawnMock.mockImplementationOnce(() => {
        queueMicrotask(() => {
          original.child.emit("error", new Error(syntheticFailureText));
          original.child.stdin.destroy();
          original.child.stdout.destroy();
          original.child.stderr.destroy();
          original.child.emit("close", null, null);
        });
        return original.child as unknown as ChildProcess;
      });
      const launcher = createWindowsJournalLauncher(options());
      const pending = read(launcher);
      await expireReadAndCleanup();
      expectUnknown(await pending, "unknown");
      expectUnknown(await read(launcher), "unknown");
      expect(() =>
        original.child.stdout.emit("error", new Error(syntheticFailureText)),
      ).not.toThrow();
      expect(() =>
        original.child.emit("error", new Error(syntheticFailureText)),
      ).not.toThrow();
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    it.each(["stdin", "stdout", "stderr"] as const)(
      "handles an injected %s error during first input without unhandled error or rejection",
      async (stream) => {
        const unhandled: unknown[] = [];
        const collect = (error: unknown) => {
          unhandled.push(error);
        };
        process.on("unhandledRejection", collect);
        try {
          const original = installReader({
            onFirstInput({ child }) {
              child[stream].emit("error", new Error(syntheticFailureText));
            },
          });
          const launcher = createWindowsJournalLauncher(options());
          const pending = read(launcher);
          await expireReadAndCleanup();
          expectUnknown(await pending, "unknown");
          expectUnknown(await read(launcher), "unknown");
          expect(() =>
            original.child[stream].emit(
              "error",
              new Error(syntheticFailureText),
            ),
          ).not.toThrow();
          await flushEvents();
          expect(unhandled).toEqual([]);
          expect(spawnMock).toHaveBeenCalledTimes(1);
        } finally {
          process.off("unhandledRejection", collect);
        }
      },
    );

    it("settles once and starts one cleanup deadline for competing abort, error and timeout", async () => {
      const original = installReader({ autoComplete: false });
      const controller = new AbortController();
      const launcher = createWindowsJournalLauncher(options());
      const pending = read(launcher, undefined, controller.signal);
      let settlements = 0;
      void pending.then(() => settlements++);
      controller.abort();
      original.child.emit("error", new Error(syntheticFailureText));
      await vi.advanceTimersByTimeAsync(testLimits.cleanupTimeoutMs - 1);
      original.child.stderr.emit("error", new Error(syntheticFailureText));
      expect(settlements).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expectUnknown(await pending, "unknown");
      await expireReadAndCleanup();
      expect(settlements).toBe(1);
      expect(original.child.kill).toHaveBeenCalledTimes(1);
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    const invalidPaths: readonly [string, Partial<Options>][] = [
      ["relative helper", { executablePath: "reader.exe" }],
      ["drive-relative helper", { executablePath: "Z:reader.exe" }],
      [
        "UNC helper",
        { executablePath: "\\\\synthetic-host\\share\\reader.exe" },
      ],
      [
        "device namespace helper",
        { executablePath: "\\\\?\\Z:\\contract-only\\reader.exe" },
      ],
      ["helper without .exe", { executablePath: "Z:\\contract-only\\reader" }],
      ["helper with .com", { executablePath: "Z:\\contract-only\\reader.com" }],
      ["NUL helper", { executablePath: "Z:\\contract-only\\read\u0000er.exe" }],
      [
        "ill-formed helper",
        { executablePath: "Z:\\contract-only\\\ud800.exe" },
      ],
      ["relative records root", { recordsRoot: ".\\records" }],
      [
        "UNC records root",
        { recordsRoot: "\\\\synthetic-host\\share\\records" },
      ],
      ["ill-formed records root", { recordsRoot: "Z:\\contract-only\\\ud800" }],
    ];

    it.each(invalidPaths)(
      "rejects deployment path before child creation: %s",
      (_name, patch) => {
        expect(() => createWindowsJournalLauncher(options(patch))).toThrow();
        expect(spawnMock).not.toHaveBeenCalled();
      },
    );

    const invalidLimits: readonly [string, number][] = [
      ["maxRequestBytes", 0],
      ["maxStdoutBytes", -1],
      ["maxStderrBytes", 1.5],
      ["readTimeoutMs", Number.NaN],
      ["cleanupTimeoutMs", Number.POSITIVE_INFINITY],
      ["maxRequestBytes", Number.MAX_SAFE_INTEGER + 1],
      ...["maxRequestBytes", "maxStdoutBytes", "maxStderrBytes"].map(
        (key): [string, number] => [key, bufferConstants.MAX_LENGTH + 1],
      ),
      ["readTimeoutMs", 2_147_483_648],
      ["cleanupTimeoutMs", 2_147_483_648],
    ];

    it.each(invalidLimits)(
      "rejects invalid explicit policy %s=%s before child creation",
      (key, value) => {
        expect(() =>
          createWindowsJournalLauncher(
            options({
              limits: { ...testLimits, [key]: value },
            }),
          ),
        ).toThrow();
        expect(spawnMock).not.toHaveBeenCalled();
      },
    );

    it.each(["unknown", "symbol", "accessor", "missing"] as const)(
      "rejects %s policy properties without evaluating getters",
      (shape) => {
        const limits: ObjectValue = { ...testLimits };
        const getter = vi.fn(() => 100);
        if (shape === "unknown") limits.extraPolicy = 1;
        if (shape === "symbol")
          Object.defineProperty(limits, Symbol("policy"), { value: 1 });
        if (shape === "accessor")
          Object.defineProperty(limits, "readTimeoutMs", {
            enumerable: true,
            get: getter,
          });
        if (shape === "missing") delete limits.cleanupTimeoutMs;
        expect(() =>
          createWindowsJournalLauncher(
            options({ limits: limits as Options["limits"] }),
          ),
        ).toThrow();
        expect(getter).not.toHaveBeenCalled();
        expect(spawnMock).not.toHaveBeenCalled();
      },
    );

    it.each([
      ["nonstring value", { VALUE: 1 }],
      ["ill-formed value", { VALUE: "\ud800" }],
      ["NUL value", { VALUE: "x\u0000y" }],
      ["invalid key", { "BAD=KEY": "value" }],
      ["ill-formed key", { "\ud800": "value" }],
    ])("rejects environment %s before child creation", (_name, environment) => {
      expect(() =>
        createWindowsJournalLauncher(
          options({
            environment: environment as unknown as Options["environment"],
          }),
        ),
      ).toThrow();
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it.each(["accessor", "symbol", "nonenumerable"] as const)(
      "rejects %s environment properties without evaluating getters",
      (shape) => {
        const environment: ObjectValue = {};
        const getter = vi.fn(() => syntheticFailureText);
        if (shape === "accessor")
          Object.defineProperty(environment, "VALUE", {
            enumerable: true,
            get: getter,
          });
        if (shape === "symbol")
          Object.defineProperty(environment, Symbol("environment"), {
            value: "value",
          });
        if (shape === "nonenumerable")
          Object.defineProperty(environment, "VALUE", { value: "value" });
        expect(() =>
          createWindowsJournalLauncher(
            options({ environment: environment as Options["environment"] }),
          ),
        ).toThrow();
        expect(getter).not.toHaveBeenCalled();
        expect(spawnMock).not.toHaveBeenCalled();
      },
    );

    it("uses one fixed sanitized factory error for invalid path and invalid policy", () => {
      const failure = (configured: Options): Error => {
        let error: unknown;
        try {
          createWindowsJournalLauncher(configured);
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(Error);
        return error as Error;
      };
      const badPath = failure(
        options({ executablePath: syntheticFailureText }),
      );
      const badPolicy = failure(
        options({ limits: { ...testLimits, readTimeoutMs: 0 } }),
      );
      expect(badPath.message).toBe(badPolicy.message);
      expect(badPath.message.length).toBeGreaterThan(0);
      expect(badPath.message).not.toContain(syntheticFailureText);
      expect(spawnMock).not.toHaveBeenCalled();
    });
  },
);

describe.runIf(process.platform !== "win32")(
  "Windows-only factory boundary",
  () => {
    it("rejects unsupported platform before child creation", () => {
      spawnMock.mockReset();
      expect(() => createWindowsJournalLauncher(options())).toThrow();
      expect(spawnMock).not.toHaveBeenCalled();
    });
  },
);

describe("frozen original Windows journal context", () => {
  it("keeps the complete synthetic fixture compatible with the unchanged interpreter", () => {
    const fixture = journalLauncherFixture();
    expect(
      interpretWindowsJournalSnapshot(
        fixture.snapshot,
        fixture.scope,
        fixture.descriptor,
      ).kind,
    ).toBe("engine-exit");
  });

  it("returns a deep-frozen independent copy of scope and descriptor", () => {
    const fixture = journalLauncherFixture();
    const original = structuredClone(fixture);
    const context = freezeWindowsJournalReadContext(
      fixture.scope,
      fixture.descriptor,
    );
    expect(context).toEqual({
      scope: original.scope,
      descriptor: original.descriptor,
    });
    expectDeepFrozen(context);
    expect(context.scope).not.toBe(fixture.scope);
    expect(context.scope.target.identity).not.toBe(
      fixture.scope.target.identity,
    );
    expect(context.descriptor.details).not.toBe(fixture.descriptor.details);
    setData(fixture.scope.target.identity, "fence", 99);
    setData(fixture.descriptor.details, "jobName", "mutated-synthetic-job");
    expect(context).toEqual({
      scope: original.scope,
      descriptor: original.descriptor,
    });
  });

  it.each([
    "scope mismatch",
    "unsafe integer",
    "negative zero",
    "symbol",
  ] as const)("rejects invalid context: %s", (shape) => {
    const fixture = journalLauncherFixture();
    if (shape === "scope mismatch")
      setData(fixture.scope.target.identity, "fence", 99);
    if (shape === "unsafe integer")
      setData(
        fixture.scope.target.identity,
        "attemptNo",
        Number.MAX_SAFE_INTEGER + 1,
      );
    if (shape === "negative zero")
      setData(objectAt(fixture.descriptor, "details", "supervisor"), "pid", -0);
    if (shape === "symbol")
      Object.defineProperty(fixture.descriptor.details, Symbol("fact"), {
        value: 1,
      });
    expect(() =>
      freezeWindowsJournalReadContext(fixture.scope, fixture.descriptor),
    ).toThrow("invalid Windows journal snapshot");
  });

  it.each(["accessor", "toJSON"] as const)(
    "rejects %s context without calling it",
    (shape) => {
      const fixture = journalLauncherFixture();
      const callback = vi.fn(() => {
        throw new Error(syntheticFailureText);
      });
      if (shape === "accessor")
        Object.defineProperty(fixture.scope, "target", {
          enumerable: true,
          get: callback,
        });
      else setData(fixture.descriptor.details, "toJSON", callback);
      expect(() =>
        freezeWindowsJournalReadContext(fixture.scope, fixture.descriptor),
      ).toThrow("invalid Windows journal snapshot");
      expect(callback).not.toHaveBeenCalled();
    },
  );
});
