import { spawn } from "node:child_process";
import { access, lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { runnerLimits } from "./storage-fixtures.js";

const selected = process.env.ZEB_WINDOWS_ROOT_EXIT_OS_TESTS === "1";
const windowsSuite = selected ? describe : describe.skip;
const executionMs = runnerLimits.executionTimeoutMs;
const cleanupMs = runnerLimits.cancelGraceMs;
const fixtureMs = executionMs + cleanupMs;
const testMs = fixtureMs + cleanupMs;

type Close = { code: number | null; signal: NodeJS.Signals | null };
type Evidence = {
  scenario: string;
  passed: boolean;
  failures: string[];
  cleanup: {
    allPinnedJoined: boolean;
    observedPins: number;
    expectedPins: number;
    stdout: { eof: boolean; error: string | null } | null;
    stderr: { eof: boolean; error: string | null } | null;
  };
};

windowsSuite.sequential("Windows original root exit observation", () => {
  let executable: string;

  beforeAll(async () => {
    if (process.platform !== "win32")
      throw new Error(
        "Windows root-exit OS tests were selected on a non-Windows host.",
      );
    const fixture = process.env.ZEB_WINDOWS_ROOT_EXIT_FIXTURE_EXE;
    if (!fixture)
      throw new Error(
        "ZEB_WINDOWS_ROOT_EXIT_FIXTURE_EXE must name the built self-contained fixture.",
      );
    executable = resolve(fixture);
    await access(executable);
  });

  it.each([
    [
      "suspended-natural",
      "suspended prepare waits for authorization and retains the original natural result after Dispose",
    ],
    [
      "root-before-descendant",
      "original root completion leaves the live descendant and tree wait pending",
    ],
    [
      "caller-cancellation",
      "one caller cancellation leaves another caller and the original root alive",
    ],
    [
      "dispose-live",
      "Dispose faults an unobserved root wait while an independent original-object pin joins physical exit",
    ],
  ])(
    "%s: %s",
    async (scenario) => {
      const directory = await mkdtemp(join(tmpdir(), "zeb-root-exit-"));
      const child = spawn(
        executable,
        ["case", scenario, directory, String(executionMs), String(cleanupMs)],
        {
          shell: false,
          windowsHide: true,
          stdio: "pipe",
        },
      );
      const errors: unknown[] = [];
      const outDecoder = new TextDecoder("utf-8", { fatal: true });
      const errDecoder = new TextDecoder("utf-8", { fatal: true });
      let stdout = "",
        stderr = "";
      let stdoutEof = false,
        stderrEof = false,
        guardianUsed = false;
      const decode = (decoder: TextDecoder, chunk?: Uint8Array) => {
        try {
          return decoder.decode(chunk, chunk ? { stream: true } : undefined);
        } catch (error) {
          errors.push(error);
          return "";
        }
      };
      child.stdout.on("data", (chunk: Uint8Array) => {
        stdout += decode(outDecoder, chunk);
      });
      child.stderr.on("data", (chunk: Uint8Array) => {
        stderr += decode(errDecoder, chunk);
      });
      child.stdout.once("end", () => {
        stdoutEof = true;
        stdout += decode(outDecoder);
      });
      child.stderr.once("end", () => {
        stderrEof = true;
        stderr += decode(errDecoder);
      });
      child.once("error", (error) => errors.push(error));
      child.stdin.once("error", (error) => errors.push(error));
      child.stdout.once("error", (error) => errors.push(error));
      child.stderr.once("error", (error) => errors.push(error));
      child.stdin.end();
      const closed = new Promise<Close>((resolveClosed) => {
        child.once("close", (code, signal) => resolveClosed({ code, signal }));
      });
      let guard: ReturnType<typeof setTimeout> | undefined;
      let closeGuard: ReturnType<typeof setTimeout> | undefined;
      let originalClose: Close | null = null;
      try {
        originalClose = await Promise.race([
          closed,
          new Promise<never>((_, reject) => {
            guard = setTimeout(() => {
              guardianUsed = true;
              if (!child.kill())
                errors.push(
                  new Error(
                    "Emergency termination of the original fixture was not accepted.",
                  ),
                );
              closeGuard = setTimeout(
                () =>
                  reject(
                    new Error(
                      "Emergency fixture termination did not produce original close and stream joins.",
                    ),
                  ),
                cleanupMs,
              );
              void closed.then((close) => {
                originalClose = close;
                if (closeGuard) clearTimeout(closeGuard);
                reject(
                  new Error(
                    "Root-exit fixture required emergency termination after its unchanged execution and cleanup bounds.",
                  ),
                );
              });
            }, fixtureMs);
          }),
        ]);
        process.stdout.write(`[WINDOWS-ROOT-EXIT] ${stdout.trim()}\n`);
        expect(guardianUsed).toBe(false);
        expect(errors).toEqual([]);
        expect(stdoutEof).toBe(true);
        expect(stderrEof).toBe(true);
        expect(stderr).toBe("");
        const evidence = JSON.parse(stdout.trim()) as Evidence;
        expect(evidence.scenario).toBe(scenario);
        expect(evidence.passed, evidence.failures.join("\n")).toBe(true);
        expect(evidence.cleanup.allPinnedJoined).toBe(true);
        expect(evidence.cleanup.observedPins).toBe(
          evidence.cleanup.expectedPins,
        );
        if (scenario !== "dispose-live") {
          expect(evidence.cleanup.stdout?.eof).toBe(true);
          expect(evidence.cleanup.stderr?.eof).toBe(true);
        }
        expect(originalClose).toEqual({ code: 0, signal: null });
        const canonical = await realpath(directory);
        const info = await lstat(directory);
        expect(info.isSymbolicLink()).toBe(false);
        expect(dirname(canonical).toLowerCase()).toBe(
          (await realpath(tmpdir())).toLowerCase(),
        );
        expect(basename(canonical)).toMatch(/^zeb-root-exit-/);
        await rm(canonical, { recursive: true });
      } finally {
        if (guard) clearTimeout(guard);
        if (closeGuard) clearTimeout(closeGuard);
        process.stdout.write(
          `[WINDOWS-ROOT-EXIT-CALLER] ${JSON.stringify({ scenario, directory, originalClose, stdoutEof, stderrEof, guardianUsed, errors: errors.map(String) })}\n`,
        );
      }
    },
    testMs,
  );
});
