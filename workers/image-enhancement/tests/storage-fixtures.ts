import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";

import { createWorkerConfig, type RunnerLimits } from "../src/config.js";
import { createJobService } from "../src/jobs.js";
import { authenticate } from "../src/credentials.js";
import { initializeStore, type EnhancementStore } from "../src/store.js";
import { configInput, planInput } from "./fixtures.js";

export const submissionLimits = Object.freeze({
  maxWaitingJobs: 2,
  queueTimeoutMs: 30_000,
  maxIdempotencyKeyLength: 128,
});

export const runnerLimits: RunnerLimits = Object.freeze({
  executionTimeoutMs: 60_000,
  cancelGraceMs: 5_000,
  leaseDurationMs: 15_000,
  heartbeatIntervalMs: 5_000,
});

export const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

export async function sourceImage(color = "red") {
  return sharp({
    create: { width: 4, height: 3, channels: 3, background: color },
  })
    .jpeg()
    .toBuffer();
}

export function submission(sourceBytes: Buffer, idempotencyKey = "request-1") {
  return {
    idempotencyKey,
    sourceBytes,
    plan: planInput(sha256(sourceBytes)),
  };
}

export async function recursiveFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? recursiveFiles(path) : [path];
      }),
    )
  ).flat();
}

export async function diskContains(directory: string, text: string) {
  for (const path of await recursiveFiles(directory)) {
    if ((await readFile(path)).includes(Buffer.from(text))) return true;
  }
  return false;
}

export async function storageFixture() {
  const directory = await mkdtemp(join(tmpdir(), "enhancement-store-"));
  let now = 1_000;
  let ready = true;
  let currentConfig = createWorkerConfig(configInput());
  let currentRunnerLimits = runnerLimits;
  const clock = () => now;
  const initialized = initializeStore({ directory, clock });
  let store = initialized.store;
  const principal = () =>
    authenticate(store, `Bearer ${initialized.credential.key}`);
  const service = () =>
    createJobService({
      store,
      config: () => currentConfig,
      ready: () => ready,
      limits: submissionLimits,
      runnerLimits: currentRunnerLimits,
    });
  return {
    directory,
    initialized,
    clock,
    get store() {
      return store;
    },
    setStore(value: EnhancementStore) {
      store = value;
    },
    setNow(value: number) {
      now = value;
    },
    setReady(value: boolean) {
      ready = value;
    },
    setConfig(value: ReturnType<typeof createWorkerConfig>) {
      currentConfig = value;
    },
    setRunnerLimits(value: RunnerLimits) {
      currentRunnerLimits = value;
    },
    principal,
    service,
    async cleanup() {
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
