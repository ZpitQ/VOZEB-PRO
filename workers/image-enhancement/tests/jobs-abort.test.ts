import { readdir } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { createWorkerConfig } from "../src/config.js";
import { createJobService } from "../src/jobs.js";
import { configInput } from "./fixtures.js";
import {
  sourceImage,
  runnerLimits,
  storageFixture,
  submission,
  submissionLimits,
} from "./storage-fixtures.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("optional durable submission cancellation signal", () => {
  it.each(["already-aborted", "readiness-aborts"])(
    "never commits a request whose signal is %s at the commit boundary",
    async (stage) => {
      const f = await storageFixture();
      cleanups.push(() => f.cleanup());
      const controller = new AbortController();
      if (stage === "already-aborted") controller.abort();
      const service = createJobService({
        store: f.store,
        config: () => createWorkerConfig(configInput()),
        limits: submissionLimits,
        runnerLimits,
        ready: () => {
          if (stage === "readiness-aborts") controller.abort();
          return true;
        },
      });
      const request = submission(
        await sourceImage(),
        "aborted-durable-request",
      );
      await expect(
        service.submit(f.principal(), request, controller.signal),
      ).rejects.toMatchObject({ code: "invalid_request" });
      expect(
        f.store.findByKey(f.principal(), request.idempotencyKey),
      ).toBeUndefined();
      expect(await readdir(f.store.inputDirectory)).toEqual([]);
    },
  );
});
