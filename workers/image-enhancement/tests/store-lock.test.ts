import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { initializeStore } from "../src/store.js";

function childLock(directory: string) {
  const child = fork(
    fileURLToPath(new URL("./store-lock-child.mjs", import.meta.url)),
    [directory],
    {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      execArgv: [],
    },
  );
  const message = new Promise<{ status: string; code?: string }>(
    (resolve, reject) => {
      child.once("message", (value) =>
        resolve(value as { status: string; code?: string }),
      );
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code !== 0) reject(new Error(`lock fixture exited ${code}`));
      });
    },
  );
  return { child, message };
}

describe("exclusive service lock across actual Node processes", () => {
  it("refuses the second service and releases the OS-backed lock on owner close", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "enhancement-lock-process-"),
    );
    const initialized = initializeStore({ directory, clock: () => 1_000 });
    initialized.store.close();
    const first = childLock(directory);
    let second: ReturnType<typeof childLock> | undefined;
    let third: ReturnType<typeof childLock> | undefined;
    try {
      expect(await first.message).toEqual({ status: "locked" });
      second = childLock(directory);
      expect(await second.message).toEqual({
        status: "refused",
        code: "store_locked",
      });
      const released = new Promise<void>((resolve) =>
        first.child.once("exit", () => resolve()),
      );
      first.child.send("close");
      await released;
      third = childLock(directory);
      expect(await third.message).toEqual({ status: "locked" });
    } finally {
      for (const candidate of [first, second, third]) {
        if (candidate && candidate.child.exitCode === null) {
          const exited = new Promise<void>((resolve) =>
            candidate.child.once("exit", () => resolve()),
          );
          candidate.child.kill();
          await exited;
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
});
