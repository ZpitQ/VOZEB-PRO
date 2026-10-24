import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createWorkerConfig,
  type SubmissionLimits,
  type WorkerConfig,
} from "../src/config.js";
import {
  EnhancementError,
  type EnhancementErrorCode,
} from "../src/contracts.js";
import { createJobService, localInputFiles } from "../src/jobs.js";
import { configInput } from "./fixtures.js";
import { snapshot } from "./lifecycle-fixtures.js";
import {
  runnerLimits,
  sourceImage,
  storageFixture,
  submission,
  submissionLimits,
} from "./storage-fixtures.js";

const prefix = "vozeb:self-test:v1:";
type Storage = Awaited<ReturnType<typeof storageFixture>>;
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const storage = await storageFixture();
  cleanups.push(() => storage.cleanup());
  return storage;
}

function service(
  storage: Storage,
  settings: Readonly<{
    internalIdempotencyKey?: string;
    config?: () => WorkerConfig;
    ready?: () => boolean;
    limits?: SubmissionLimits;
    files?: typeof localInputFiles;
  }> = {},
) {
  // A local options value keeps this test loadable before the new option exists.
  const options = {
    store: storage.store,
    config: settings.config ?? (() => createWorkerConfig(configInput())),
    ready: settings.ready ?? (() => true),
    limits: settings.limits ?? submissionLimits,
    runnerLimits,
    files: settings.files ?? localInputFiles,
    ...(settings.internalIdempotencyKey === undefined
      ? {}
      : { internalIdempotencyKey: settings.internalIdempotencyKey }),
  };
  return createJobService(options);
}

function inputProbe() {
  let calls = 0;
  const files: typeof localInputFiles = {
    async mkdir(path) {
      calls++;
      await localInputFiles.mkdir(path);
    },
    async write(path, bytes) {
      calls++;
      await localInputFiles.write(path, bytes);
    },
    async syncDirectory(path) {
      calls++;
      await localInputFiles.syncDirectory(path);
    },
    async rename(from, to) {
      calls++;
      await localInputFiles.rename(from, to);
    },
    async remove(path) {
      calls++;
      await localInputFiles.remove(path);
    },
  };
  return { files, count: () => calls };
}

function facts(storage: Storage) {
  return snapshot(storage, (db) => ({
    jobs: db.prepare("SELECT * FROM jobs ORDER BY queue_sequence").all(),
    attempts: db.prepare("SELECT * FROM attempts ORDER BY rowid").all(),
    slot: db.prepare("SELECT * FROM execution_slot").all(),
  }));
}

async function rejected(
  action: () => Promise<unknown>,
  code: EnhancementErrorCode,
) {
  let returned = false;
  let failure: unknown;
  try {
    await action();
    returned = true;
  } catch (error) {
    failure = error;
  }
  expect(returned, "rejected submission returned no job").toBe(false);
  expect(
    failure instanceof EnhancementError && failure.code === code,
    `submission reports ${code}`,
  ).toBe(true);
}

describe("JobService internal self-test idempotency namespace", () => {
  it.each(["new", "existing", "malformed"] as const)(
    "rejects an ordinary reserved %s key before replay, config, readiness or input I/O",
    async (kind) => {
      const storage = await fixture();
      const bytes = await sourceImage();
      const key =
        kind === "malformed"
          ? `${prefix}not-a-uuid`
          : `${prefix}${randomUUID()}`;
      if (kind === "existing") {
        await service(storage, { internalIdempotencyKey: key }).submit(
          storage.principal(),
          submission(bytes, key),
        );
      }
      const before = facts(storage);
      const inputNames = await readdir(storage.store.inputDirectory);
      const probe = inputProbe();
      let configs = 0;
      let readiness = 0;
      const ordinary = service(storage, {
        config: () => {
          configs++;
          throw new Error("fixture configuration unavailable");
        },
        ready: () => {
          readiness++;
          return false;
        },
        files: probe.files,
      });
      const find = vi.spyOn(storage.store, "findByKey");
      await rejected(
        () => ordinary.submit(storage.principal(), submission(bytes, key)),
        "invalid_request",
      );
      expect(find.mock.calls.length).toBe(0);
      expect(configs).toBe(0);
      expect(readiness).toBe(0);
      expect(probe.count()).toBe(0);
      expect(
        isDeepStrictEqual(facts(storage), before),
        "durable namespace facts",
      ).toBe(true);
      expect(
        isDeepStrictEqual(
          await readdir(storage.store.inputDirectory),
          inputNames,
        ),
      ).toBe(true);
    },
  );

  it("accepts and replays only the private instance's exact key through the original submit algorithm", async () => {
    const storage = await fixture();
    const bytes = await sourceImage();
    const key = `${prefix}${randomUUID()}`;
    const probe = inputProbe();
    let configs = 0;
    let readiness = 0;
    const privateService = service(storage, {
      internalIdempotencyKey: key,
      config: () => {
        configs++;
        return createWorkerConfig(configInput());
      },
      ready: () => {
        readiness++;
        return true;
      },
      files: probe.files,
    });
    const request = submission(bytes, key);
    const first = await privateService.submit(storage.principal(), request);
    expect(first.replayed).toBe(false);
    expect(first.job.status).toBe("queued");
    expect(configs).toBe(1);
    expect(readiness).toBe(1);
    const io = probe.count();
    expect(io > 0).toBe(true);
    const before = facts(storage);
    const replay = await privateService.submit(storage.principal(), request);
    expect(replay.replayed).toBe(true);
    expect(isDeepStrictEqual(replay.job, first.job)).toBe(true);
    for (const otherKey of [`${prefix}${randomUUID()}`, "ordinary-other-key"]) {
      await rejected(
        () =>
          privateService.submit(
            storage.principal(),
            submission(bytes, otherKey),
          ),
        "invalid_request",
      );
    }
    await rejected(
      () =>
        privateService.submit(storage.principal(), {
          ...request,
          plan: {
            ...request.plan,
            target: { width: 16, height: 12, format: "png" },
          },
        }),
      "idempotency_conflict",
    );
    expect(configs).toBe(1);
    expect(readiness).toBe(1);
    expect(probe.count()).toBe(io);
    expect(
      isDeepStrictEqual(facts(storage), before),
      "one immutable accepted job",
    ).toBe(true);
    expect((await readdir(storage.store.inputDirectory)).length).toBe(1);
    expect(before.attempts.length).toBe(0);
    expect(before.slot.length).toBe(0);
  });

  it.each([
    ["empty", ""],
    ["empty suffix", prefix],
    ["ordinary", "ordinary-key"],
    ["arbitrary suffix", `${prefix}identifier`],
    [
      "uppercase prefix",
      `${prefix.toUpperCase()}a50e3af5-8e82-4bad-8c0b-a1ae6f5b3629`,
    ],
    ["uppercase UUID", `${prefix}A50E3AF5-8E82-4BAD-8C0B-A1AE6F5B3629`],
    ["wrong version", `${prefix}a50e3af5-8e82-3bad-8c0b-a1ae6f5b3629`],
    ["wrong variant", `${prefix}a50e3af5-8e82-4bad-7c0b-a1ae6f5b3629`],
    ["extra suffix", `${prefix}a50e3af5-8e82-4bad-8c0b-a1ae6f5b3629:extra`],
  ] as const)(
    "rejects a %s private option during construction",
    async (_label, key) => {
      const storage = await fixture();
      const before = facts(storage);
      const probe = inputProbe();
      let configs = 0;
      let failure: unknown;
      let returned = false;
      try {
        service(storage, {
          internalIdempotencyKey: key,
          config: () => {
            configs++;
            return createWorkerConfig(configInput());
          },
          files: probe.files,
        });
        returned = true;
      } catch (error) {
        failure = error;
      }
      expect(returned).toBe(false);
      expect(
        failure instanceof EnhancementError &&
          failure.code === "configuration_invalid",
      ).toBe(true);
      expect(configs).toBe(0);
      expect(probe.count()).toBe(0);
      expect(isDeepStrictEqual(facts(storage), before)).toBe(true);
      expect((await readdir(storage.store.inputDirectory)).length).toBe(0);
    },
  );

  it("applies the existing maximum key length to a canonically shaped private option", async () => {
    const storage = await fixture();
    const key = `${prefix}${randomUUID()}`;
    const limits = {
      ...submissionLimits,
      maxIdempotencyKeyLength: key.length - 1,
    };
    const before = facts(storage);
    let failure: unknown;
    let returned = false;
    try {
      service(storage, { internalIdempotencyKey: key, limits });
      returned = true;
    } catch (error) {
      failure = error;
    }
    expect(returned).toBe(false);
    expect(
      failure instanceof EnhancementError &&
        failure.code === "configuration_invalid",
    ).toBe(true);
    expect(limits.maxIdempotencyKeyLength).toBe(key.length - 1);
    expect(isDeepStrictEqual(facts(storage), before)).toBe(true);
    expect((await readdir(storage.store.inputDirectory)).length).toBe(0);
  });

  it("keeps ordinary replay and conflict ahead of unavailable config, readiness and a full queue", async () => {
    const storage = await fixture();
    const bytes = await sourceImage();
    const request = submission(bytes, "ordinary-replay");
    const accepted = await storage
      .service()
      .submit(storage.principal(), request);
    await storage
      .service()
      .submit(storage.principal(), submission(bytes, "ordinary-capacity"));
    const before = facts(storage);
    expect(before.jobs.length).toBe(submissionLimits.maxWaitingJobs);
    const probe = inputProbe();
    let configs = 0;
    let readiness = 0;
    const ordinary = service(storage, {
      config: () => {
        configs++;
        throw new Error("fixture configuration unavailable");
      },
      ready: () => {
        readiness++;
        return false;
      },
      files: probe.files,
    });
    const replay = await ordinary.submit(storage.principal(), request);
    expect(replay.replayed).toBe(true);
    expect(isDeepStrictEqual(replay.job, accepted.job)).toBe(true);
    await rejected(
      () =>
        ordinary.submit(storage.principal(), {
          ...request,
          plan: {
            ...request.plan,
            target: { width: 16, height: 12, format: "png" },
          },
        }),
      "idempotency_conflict",
    );
    expect(configs).toBe(0);
    expect(readiness).toBe(0);
    expect(probe.count()).toBe(0);
    expect(isDeepStrictEqual(facts(storage), before)).toBe(true);
  });

  it.each(["digest", "plan"] as const)(
    "retains original %s validation before rejecting a reserved key",
    async (mode) => {
      const storage = await fixture();
      const request = submission(await sourceImage(), `${prefix}malformed`);
      if (mode === "digest") request.plan.sourceSha256 = "0".repeat(64);
      if (mode === "plan") request.plan.tile = 1;
      const before = facts(storage);
      await rejected(
        () => service(storage).submit(storage.principal(), request),
        mode === "digest" ? "input_digest_mismatch" : "invalid_plan",
      );
      expect(isDeepStrictEqual(facts(storage), before)).toBe(true);
      expect((await readdir(storage.store.inputDirectory)).length).toBe(0);
    },
  );

  it.each([
    ["not ready", "not_ready"],
    ["full queue", "queue_full"],
    ["digest", "input_digest_mismatch"],
    ["budget", "budget_exceeded"],
    ["already aborted", "invalid_request"],
    ["readiness aborts", "invalid_request"],
    ["forged principal", "authentication_failed"],
  ] as const)(
    "preserves original %s rejection for the private exact key",
    async (mode, code) => {
      const storage = await fixture();
      const bytes = await sourceImage();
      if (mode === "full queue") {
        for (let index = 0; index < submissionLimits.maxWaitingJobs; index++) {
          await storage
            .service()
            .submit(
              storage.principal(),
              submission(bytes, `capacity-${index}`),
            );
        }
      }
      const key = `${prefix}${randomUUID()}`;
      const request = submission(bytes, key);
      if (mode === "digest") request.plan.sourceSha256 = "0".repeat(64);
      const config = configInput();
      if (mode === "budget") config.budgets.input.maxBytes = 1;
      const controller = new AbortController();
      if (mode === "already aborted") controller.abort();
      const probe = inputProbe();
      const privateService = service(storage, {
        internalIdempotencyKey: key,
        config: () => createWorkerConfig(config),
        ready: () => {
          if (mode === "readiness aborts") controller.abort();
          return mode !== "not ready";
        },
        files: probe.files,
      });
      const principal = storage.principal();
      const before = facts(storage);
      const inputNames = await readdir(storage.store.inputDirectory);
      await rejected(
        () =>
          privateService.submit(
            mode === "forged principal" ? { ...principal } : principal,
            request,
            controller.signal,
          ),
        code,
      );
      expect(
        isDeepStrictEqual(facts(storage), before),
        "original admission facts",
      ).toBe(true);
      expect(
        isDeepStrictEqual(
          await readdir(storage.store.inputDirectory),
          inputNames,
        ),
      ).toBe(true);
      expect(storage.store.findByKey(principal, key) === undefined).toBe(true);
      if (
        ["digest", "budget", "already aborted", "forged principal"].includes(
          mode,
        )
      ) {
        expect(probe.count()).toBe(0);
      }
    },
  );
});
