import { constants as bufferConstants } from "node:buffer";
import { spawn, type ChildProcess } from "node:child_process";
import { win32 } from "node:path";
import type { Readable, Writable } from "node:stream";

import { visit } from "jsonc-parser";

import type { OwnerDescriptor } from "./execution.js";
import {
  freezeWindowsJournalReadContext,
  interpretWindowsJournalSnapshot,
  type WindowsJournalInterpretation,
  type WindowsJournalReadContext,
  type WindowsJournalScope,
} from "./windows-journal-reader.js";

export type WindowsJournalReadLimits = Readonly<{
  maxRequestBytes: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  readTimeoutMs: number;
  cleanupTimeoutMs: number;
}>;

export function freezeWindowsJournalReadLimits(
  value: unknown,
): WindowsJournalReadLimits {
  try {
    const rawLimits = dataObject(value);
    const keys = Reflect.ownKeys(rawLimits);
    if (
      keys.length !== limitKeys.length ||
      !keys.every(
        (key) =>
          typeof key === "string" &&
          (limitKeys as readonly string[]).includes(key),
      )
    )
      invalidConfiguration();
    const limits = Object.fromEntries(
      limitKeys.map((key) => {
        const value = ownData(rawLimits, key);
        const maximum = key.endsWith("Bytes")
          ? bufferConstants.MAX_LENGTH
          : 2_147_483_647;
        if (
          typeof value !== "number" ||
          !Number.isSafeInteger(value) ||
          value <= 0 ||
          value > maximum
        )
          invalidConfiguration();
        return [key, value];
      }),
    ) as WindowsJournalReadLimits;
    return Object.freeze(limits);
  } catch {
    return invalidConfiguration();
  }
}

export type WindowsJournalReadResult =
  | Readonly<{
      kind: "read";
      interpretation: WindowsJournalInterpretation;
      cleanup: "closed";
    }>
  | Readonly<{ kind: "unknown"; cleanup: "closed" | "unknown" }>;

export type WindowsJournalLauncher = Readonly<{
  read(
    scope: WindowsJournalScope,
    descriptor: OwnerDescriptor,
    signal: AbortSignal,
    stillCurrent: () => boolean,
  ): Promise<WindowsJournalReadResult>;
  close(): Promise<"closed" | "unknown">;
}>;

type Cleanup = "closed" | "unknown";
type ReaderOwner = Readonly<{ cancel(): Promise<Cleanup> }>;
type LauncherOptions = Readonly<{
  executablePath: string;
  recordsRoot: string;
  environment: Readonly<Record<string, string>>;
  limits: WindowsJournalReadLimits;
}>;

const unknownClosed: WindowsJournalReadResult = Object.freeze({
  kind: "unknown",
  cleanup: "closed",
});
const unknownOwned: WindowsJournalReadResult = Object.freeze({
  kind: "unknown",
  cleanup: "unknown",
});
const limitKeys = [
  "maxRequestBytes",
  "maxStdoutBytes",
  "maxStderrBytes",
  "readTimeoutMs",
  "cleanupTimeoutMs",
] as const;
const isWellFormed = (
  String.prototype as unknown as { isWellFormed(this: string): boolean }
).isWellFormed;

function invalidConfiguration(): never {
  throw new Error("invalid Windows journal launcher configuration");
}

function ownData(source: object, key: string): unknown {
  const property = Object.getOwnPropertyDescriptor(source, key);
  if (!property || !("value" in property) || !property.enumerable)
    invalidConfiguration();
  return property.value;
}

function dataObject(value: unknown): object {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalidConfiguration();
  return value;
}

function localPath(value: unknown, executable = false): string {
  if (
    typeof value !== "string" ||
    !isWellFormed.call(value) ||
    value.includes("\u0000") ||
    !/^[A-Za-z]:[\\/]/.test(value) ||
    !win32.isAbsolute(value) ||
    (executable && !value.toLowerCase().endsWith(".exe"))
  )
    invalidConfiguration();
  return value;
}

function configuration(options: LauncherOptions): LauncherOptions {
  try {
    if (process.platform !== "win32") invalidConfiguration();
    const source = dataObject(options);
    if (
      Reflect.ownKeys(source).length !== 4 ||
      !["executablePath", "recordsRoot", "environment", "limits"].every((key) =>
        Object.hasOwn(source, key),
      )
    )
      invalidConfiguration();
    const executablePath = localPath(ownData(source, "executablePath"), true);
    const recordsRoot = localPath(ownData(source, "recordsRoot"));
    const limits = freezeWindowsJournalReadLimits(ownData(source, "limits"));
    const rawEnvironment = dataObject(ownData(source, "environment"));
    const environment = Object.fromEntries(
      Reflect.ownKeys(rawEnvironment).map((key) => {
        if (
          typeof key !== "string" ||
          key.length === 0 ||
          !isWellFormed.call(key) ||
          key.includes("\u0000") ||
          key.includes("=")
        )
          invalidConfiguration();
        const value = ownData(rawEnvironment, key);
        if (
          typeof value !== "string" ||
          !isWellFormed.call(value) ||
          value.includes("\u0000")
        )
          invalidConfiguration();
        return [key, value];
      }),
    );
    return Object.freeze({
      executablePath,
      recordsRoot,
      environment: Object.freeze(environment),
      limits,
    });
  } catch {
    return invalidConfiguration();
  }
}

function responseObject(bytes: Buffer): unknown {
  if (
    bytes.length < 3 ||
    bytes[0] !== 0x7b ||
    bytes[bytes.length - 2] !== 0x7d ||
    bytes[bytes.length - 1] !== 0x0a ||
    bytes.indexOf(0x0a) !== bytes.length - 1 ||
    bytes.includes(0x0d)
  )
    throw new Error("invalid Windows journal reader response");
  const document = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes.subarray(0, -1));
  const objects: Set<string>[] = [];
  let invalid = false;
  visit(
    document,
    {
      onObjectBegin() {
        objects.push(new Set());
      },
      onObjectProperty(property) {
        const keys = objects[objects.length - 1];
        if (!keys || keys.has(property)) invalid = true;
        keys?.add(property);
      },
      onObjectEnd() {
        objects.pop();
      },
      onError() {
        invalid = true;
      },
    },
    {
      disallowComments: true,
      allowTrailingComma: false,
      allowEmptyContent: false,
    },
  );
  if (invalid || objects.length !== 0)
    throw new Error("invalid Windows journal reader response");
  return JSON.parse(document) as unknown;
}

export function createWindowsJournalLauncher(
  options: LauncherOptions,
): WindowsJournalLauncher {
  // Complete application deployment and Windows loader inputs are trusted
  // prerequisites. Validating these values does not authenticate that deployment.
  const configured = configuration(options);
  const { limits } = configured;
  let sealed = false;
  let admitting = false;
  let owner: ReaderOwner | undefined;
  let closePromise: Promise<Cleanup> | undefined;

  function read(
    scope: WindowsJournalScope,
    descriptor: OwnerDescriptor,
    signal: AbortSignal,
    stillCurrent: () => boolean,
  ): Promise<WindowsJournalReadResult> {
    if (sealed || admitting || owner)
      return Promise.resolve(owner ? unknownOwned : unknownClosed);
    admitting = true;
    let resolveRead!: (result: WindowsJournalReadResult) => void;
    const result = new Promise<WindowsJournalReadResult>((resolve) => {
      resolveRead = resolve;
    });
    let settled = false;
    let attempted = false;
    let failed = false;
    let released = false;
    let errors = false;
    let terminationAttempted = false;
    let abortListening = false;
    let context: WindowsJournalReadContext | undefined;
    let child: ChildProcess | undefined;
    let stdin: Writable | null = null;
    let stdout: Readable | null = null;
    let stderr: Readable | null = null;
    let inputComplete = false;
    let inputFinished = false;
    let inputClosed = false;
    let stdoutEnded = false;
    let stdoutClosed = false;
    let stderrEnded = false;
    let stderrClosed = false;
    let exited = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let childClosed = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const capture: Buffer[] = [];
    let readTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanupPromise: Promise<Cleanup> | undefined;
    let resolveCleanup: ((cleanup: Cleanup) => void) | undefined;
    let cleanupSettled = false;

    function finish(value: WindowsJournalReadResult): void {
      if (settled) return;
      settled = true;
      if (readTimer !== undefined) clearTimeout(readTimer);
      readTimer = undefined;
      if (abortListening) {
        abortListening = false;
        try {
          signal.removeEventListener("abort", fail);
        } catch {
          // An invalid caller signal cannot turn a sanitized result into rejection.
        }
      }
      resolveRead(value);
    }

    function finishCleanup(cleanup: Cleanup): void {
      if (cleanupSettled) return;
      cleanupSettled = true;
      if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
      cleanupTimer = undefined;
      resolveCleanup?.(cleanup);
      finish(cleanup === "closed" ? unknownClosed : unknownOwned);
    }

    function startCleanup(): Promise<Cleanup> {
      if (!cleanupPromise) {
        cleanupPromise = new Promise<Cleanup>((resolve) => {
          resolveCleanup = resolve;
        });
        cleanupTimer = setTimeout(
          () => finishCleanup("unknown"),
          limits.cleanupTimeoutMs,
        );
      }
      return cleanupPromise;
    }

    function terminate(): void {
      if (!child || exited || terminationAttempted || released) return;
      terminationAttempted = true;
      try {
        child.kill();
      } catch {
        // Failed termination never supplies exit or pipe evidence.
      }
    }

    function fail(): void {
      if (released || failed) return;
      failed = true;
      capture.length = 0;
      if (readTimer !== undefined) clearTimeout(readTimer);
      readTimer = undefined;
      if (!attempted) {
        admitting = false;
        finish(unknownClosed);
        return;
      }
      startCleanup();
      terminate();
      observe();
    }

    const retainedOwner: ReaderOwner = Object.freeze({
      cancel() {
        fail();
        return startCleanup();
      },
    });

    function release(): void {
      released = true;
      if (owner === retainedOwner) owner = undefined;
      capture.length = 0;
    }

    function current(): boolean {
      try {
        if (sealed || signal.aborted) return false;
        return stillCurrent() === true && !sealed && !signal.aborted;
      } catch {
        return false;
      }
    }

    function observe(): void {
      if (
        released ||
        errors ||
        !child ||
        !exited ||
        !childClosed ||
        !inputClosed ||
        !stdoutEnded ||
        !stdoutClosed ||
        !stderrEnded ||
        !stderrClosed
      )
        return;
      if (failed) {
        release();
        finishCleanup("closed");
        return;
      }
      if (!inputComplete || !inputFinished) return;
      if (
        exitCode !== 0 ||
        exitSignal !== null ||
        stderrBytes !== 0 ||
        !context
      ) {
        fail();
        return;
      }
      try {
        const snapshot = responseObject(Buffer.concat(capture, stdoutBytes));
        const interpretation = interpretWindowsJournalSnapshot(
          snapshot,
          context.scope,
          context.descriptor,
        );
        if (!current() || failed) {
          fail();
          return;
        }
        release();
        finish(
          Object.freeze({ kind: "read", interpretation, cleanup: "closed" }),
        );
      } catch {
        fail();
      }
    }

    function streamError(): void {
      errors = true;
      fail();
    }

    function outputData(which: "stdout" | "stderr", chunk: unknown): void {
      if (released) return;
      if (!Buffer.isBuffer(chunk)) {
        fail();
        return;
      }
      const count = which === "stdout" ? stdoutBytes : stderrBytes;
      const maximum =
        which === "stdout" ? limits.maxStdoutBytes : limits.maxStderrBytes;
      const overflow = count > maximum || chunk.length > maximum - count;
      const next = overflow ? maximum + 1 : count + chunk.length;
      if (which === "stdout") stdoutBytes = next;
      else stderrBytes = next;
      if (overflow || (which === "stderr" && chunk.length !== 0)) {
        fail();
        return;
      }
      if (!failed && which === "stdout") {
        try {
          capture.push(Buffer.from(chunk));
        } catch {
          fail();
        }
      }
    }

    // The deadline covers this admission as observed by the Node event loop.
    readTimer = setTimeout(fail, limits.readTimeoutMs);
    try {
      context = freezeWindowsJournalReadContext(scope, descriptor);
      abortListening = true;
      signal.addEventListener("abort", fail, { once: true });
      if (!current() || failed) {
        fail();
        return result;
      }
      const request = Buffer.from(
        `${JSON.stringify({
          v: 1,
          kind: "read-windows-journal",
          scope: context.scope,
          executionId: context.descriptor.executionId,
        })}\n`,
        "utf8",
      );
      if (request.length > limits.maxRequestBytes || sealed || signal.aborted) {
        fail();
        return result;
      }

      // Attempting spawn crosses the creation uncertainty boundary, even when
      // spawn throws or the returned object's pid was never populated.
      attempted = true;
      owner = retainedOwner;
      admitting = false;
      child = spawn(
        configured.executablePath,
        ["--read-records", configured.recordsRoot],
        {
          cwd: win32.dirname(configured.executablePath),
          shell: false,
          windowsHide: true,
          windowsVerbatimArguments: false,
          // Avoid the non-detached Windows spawn branch retaining caller stdout.
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
          env: configured.environment,
        },
      );
      stdin = child.stdin;
      stdout = child.stdout;
      stderr = child.stderr;

      child.on("error", streamError);
      child.on("exit", (code, signalCode) => {
        exited = true;
        exitCode = code;
        exitSignal = signalCode;
        if (code !== 0 || signalCode !== null) fail();
        observe();
      });
      child.on("close", () => {
        childClosed = true;
        observe();
      });
      stdin?.on("error", streamError);
      stdin?.on("finish", () => {
        inputFinished = true;
        observe();
      });
      stdin?.on("close", () => {
        inputClosed = true;
        observe();
      });
      stdout?.on("error", streamError);
      stdout?.on("end", () => {
        stdoutEnded = true;
        observe();
      });
      stdout?.on("close", () => {
        stdoutClosed = true;
        observe();
      });
      stderr?.on("error", streamError);
      stderr?.on("end", () => {
        stderrEnded = true;
        observe();
      });
      stderr?.on("close", () => {
        stderrClosed = true;
        observe();
      });
      // Both original outputs keep draining after failure; close is never end.
      stdout?.on("data", (chunk: unknown) => outputData("stdout", chunk));
      stderr?.on("data", (chunk: unknown) => outputData("stderr", chunk));

      if (!stdin || !stdout || !stderr) {
        streamError();
        return result;
      }
      if (!current() || failed) {
        fail();
        terminate();
        return result;
      }
      stdin.end(request, (error?: Error | null) => {
        if (error) {
          streamError();
          return;
        }
        inputComplete = true;
        observe();
      });
    } catch {
      if (attempted) errors = true;
      fail();
    }
    return result;
  }

  function close(): Promise<Cleanup> {
    if (closePromise) return closePromise;
    sealed = true;
    let resolveClose!: (cleanup: Cleanup) => void;
    closePromise = new Promise<Cleanup>((resolve) => {
      resolveClose = resolve;
    });
    if (!owner) resolveClose("closed");
    else void owner.cancel().then(resolveClose);
    return closePromise;
  }

  return Object.freeze({ read, close });
}
