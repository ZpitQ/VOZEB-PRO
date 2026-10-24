import assert from "node:assert/strict";
import { request, type Server } from "node:http";
import { isDeepStrictEqual } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startWindowsWorker } from "../src/bootstrap.js";
import * as httpModule from "../src/http.js";
import * as runnerModule from "../src/runner.js";
import * as storeModule from "../src/store.js";
import type { createWindowsControlBridgeHost } from "../src/windows-control-bridge-host.js";
import type {
  createWindowsJournalLauncher,
  WindowsJournalLauncher,
  WindowsJournalReadResult,
} from "../src/windows-journal-launcher.js";
import { freezeWindowsPrepareRequest } from "../src/windows-prepare-payload.js";
import { configInput } from "./fixtures.js";
import { deferred, transportLimits } from "./http-fixtures.js";
import { snapshot } from "./lifecycle-fixtures.js";
import {
  runnerLimits,
  sourceImage,
  storageFixture,
  submission,
  submissionLimits,
} from "./storage-fixtures.js";
import { controlBridgeExecutionDescriptor } from "./windows-control-bridge-host-fixtures.js";
import { runnerAdapterOptions } from "./windows-execution-adapter-runner-fixtures.js";

const factories = vi.hoisted(() => ({
  host: vi.fn<typeof createWindowsControlBridgeHost>(),
  journal: vi.fn<typeof createWindowsJournalLauncher>(),
}));
vi.mock("../src/windows-control-bridge-host.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/windows-control-bridge-host.js")
  >()),
  createWindowsControlBridgeHost: factories.host,
}));
vi.mock("../src/windows-journal-launcher.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/windows-journal-launcher.js")
  >()),
  createWindowsJournalLauncher: factories.journal,
}));

type RunnerStatus = Readonly<{
  closed: boolean;
  storeClosed: boolean;
  recoveryState:
    "idle" | "inspecting" | "owned-alive" | "unknown" | "awaiting-artifacts";
  recoveryInFlight: boolean;
  ownedState: "none" | "busy" | "unknown";
}>;
type WindowsExecutionStatus = Readonly<{
  sealed: boolean;
  activity: "idle" | "busy" | "unknown" | "cleanup_unknown";
  close: "not_requested" | "pending" | "closed" | "unknown";
}>;
type RuntimeStatus = Readonly<{
  closing: boolean;
  startupRecovery: "pending" | "settled" | "failed";
  runner: RunnerStatus;
  adapter: WindowsExecutionStatus;
}>;
type Storage = Awaited<ReturnType<typeof storageFixture>>;

const appDirectory = "Z:\\contract-only\\payload\\app";
const cleanups: (() => void | Promise<void>)[] = [];
beforeEach(() => {
  factories.host.mockReset().mockImplementation(() => {
    throw new Error("unexpected test Host allocation");
  });
  factories.journal.mockReset().mockImplementation(() => {
    throw new Error("unexpected test journal allocation");
  });
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

function configuration(storeDirectory: string, operatorClientId: string) {
  return {
    storeDirectory,
    operatorClientId,
    selfTestModelId: "standard-4x",
    port: 0,
    workerConfig: configInput(),
    submissionLimits: { ...submissionLimits },
    runnerLimits: { ...runnerLimits },
    transportLimits: { ...transportLimits },
    execution: {
      installationRoot: runnerAdapterOptions.bridge.installationRoot,
      recordsRoot: runnerAdapterOptions.bridge.recordsRoot,
      expectedManifestSha256:
        runnerAdapterOptions.bridge.expectedManifestSha256,
      bridgeLimits: { ...runnerAdapterOptions.bridge.limits },
      journalLimits: { ...runnerAdapterOptions.journalLimits },
    },
  };
}

function statusReader(subject: object) {
  const status = Reflect.get(subject, "status");
  expect(typeof status, "runtime exposes its real status method").toBe(
    "function",
  );
  return () => {
    const result = (status as () => RuntimeStatus).call(subject);
    expect(Object.isFrozen(result), "frozen runtime snapshot").toBe(true);
    expect(
      Object.isFrozen(result.runner),
      "frozen nested Runner snapshot",
    ).toBe(true);
    expect(
      Object.isFrozen(result.adapter),
      "frozen nested Adapter snapshot",
    ).toBe(true);
    return result;
  };
}

function state(
  startupRecovery: RuntimeStatus["startupRecovery"],
  runner: Partial<RunnerStatus> = {},
  adapter: Partial<WindowsExecutionStatus> = {},
  closing = false,
): RuntimeStatus {
  return {
    closing,
    startupRecovery,
    runner: {
      closed: closing,
      storeClosed: closing,
      recoveryState: "idle",
      recoveryInFlight: false,
      ownedState: "none",
      ...runner,
    },
    adapter: {
      sealed: closing,
      activity: "idle",
      close: closing ? "closed" : "not_requested",
      ...adapter,
    },
  };
}

function expectStatus(actual: RuntimeStatus, expected: RuntimeStatus) {
  // Do not print a leaked Store path or credential if a projection regresses.
  expect(isDeepStrictEqual(actual, expected), "exact bootstrap status").toBe(
    true,
  );
}

function facts(storage: Storage) {
  return snapshot(storage, (db) => ({
    jobs: db.prepare("SELECT * FROM jobs ORDER BY queue_sequence").all(),
    attempts: db.prepare("SELECT * FROM attempts ORDER BY rowid").all(),
    slot: db.prepare("SELECT * FROM execution_slot").all(),
    controls: db
      .prepare("SELECT * FROM recovery_controls ORDER BY rowid")
      .all(),
    events: db.prepare("SELECT * FROM recovery_events ORDER BY rowid").all(),
  }));
}

async function flush() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function call(
  server: Server,
  authorization: string,
  path: string,
  method = "GET",
) {
  const address = server.address();
  assert.ok(address && typeof address !== "string", "listener is available");
  return new Promise<{
    status: number;
    ready?: boolean;
    cancelRequested?: boolean;
  }>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: address.port,
        method,
        path,
        agent: false,
        headers: { authorization },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.once("error", () => reject(new Error("bootstrap response failed")));
        res.once("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
              data?: { ready?: boolean; job?: { cancelRequested?: boolean } };
            };
            resolve({
              status: res.statusCode!,
              ready: body.data?.ready,
              cancelRequested: body.data?.job?.cancelRequested,
            });
          } catch {
            reject(new Error("unexpected bootstrap response"));
          }
        });
      },
    );
    req.once("error", () => reject(new Error("bootstrap request failed")));
    req.end();
  });
}

async function harness(failure?: "begin-recovery" | "sync-recover") {
  const storage = await storageFixture();
  storage.setNow(Date.now());
  // Match the existing bootstrap fixture: retain the owned directory as evidence.
  cleanups.push(() => storage.store.close());
  let server: Server | undefined;
  let recovery: Promise<void> | undefined;
  let recoverCalls = 0;
  let wakeCalls = 0;
  const create = runnerModule.createRunner;
  const runner = vi
    .spyOn(runnerModule, "createRunner")
    .mockImplementation((options) => {
      const actual = create(options);
      return Object.freeze({
        ...actual,
        recover() {
          recoverCalls++;
          expect(server?.listening).toBe(true);
          if (failure === "sync-recover")
            throw new Error("synthetic-recovery-boundary-fault");
          recovery = actual.recover();
          return recovery;
        },
        wake() {
          wakeCalls++;
          return actual.wake();
        },
      });
    });
  const originalOpen = storeModule.openStore;
  const open = vi
    .spyOn(storeModule, "openStore")
    .mockImplementation((options) => {
      const opened = originalOpen(options);
      storage.setStore(opened);
      if (failure === "begin-recovery") {
        vi.spyOn(opened, "beginRecovery").mockImplementationOnce(() => {
          throw new Error("synthetic-recovery-read-fault");
        });
      }
      return opened;
    });
  const originalListen = httpModule.listenEnhancementServer;
  const listen = vi
    .spyOn(httpModule, "listenEnhancementServer")
    .mockImplementation(async (...args) => {
      const actual = await originalListen(...args);
      server = actual;
      return actual;
    });
  return {
    storage,
    runner,
    open,
    listen,
    recoverCalls: () => recoverCalls,
    wakeCalls: () => wakeCalls,
    recovery: () => recovery,
    async start() {
      storage.store.close();
      const runtime = await startWindowsWorker(
        configuration(
          storage.directory,
          storage.initialized.credential.clientId,
        ),
        {
          appDirectory,
          signal: new AbortController().signal,
        },
      );
      cleanups.push(() => runtime.close());
      return runtime;
    },
  };
}

async function pendingRecovery(storage: Storage, holdCleanup = false) {
  const accepted = await storage
    .service()
    .submit(storage.principal(), submission(await sourceImage()));
  const attempt = storage.store.claimNext("bootstrap-status-previous-owner");
  assert.ok(attempt, "accepted fixture job has an original claim");
  const prepared = freezeWindowsPrepareRequest(attempt);
  const descriptor = controlBridgeExecutionDescriptor(
    { identity: attempt.identity, launchTicket: attempt.launchTicket },
    attempt.executionPolicy.fingerprint,
    prepared.requestFingerprint,
  );
  expect(storage.store.registerPrepared(attempt.identity, descriptor)).toBe(
    true,
  );
  expect(storage.store.authorizeLaunch(attempt.identity, descriptor)).toBe(
    true,
  );
  const result = deferred<WindowsJournalReadResult>();
  const cleanup = deferred<"closed" | "unknown">();
  const reader = {
    read: vi.fn<WindowsJournalLauncher["read"]>(() => result.promise),
    close: vi.fn<WindowsJournalLauncher["close"]>(() =>
      holdCleanup ? cleanup.promise : Promise.resolve("closed"),
    ),
  } satisfies WindowsJournalLauncher;
  factories.journal.mockReturnValue(reader);
  cleanups.push(() => {
    result.resolve({ kind: "unknown", cleanup: "closed" });
    cleanup.resolve("closed");
  });
  return { accepted, reader, result, cleanup };
}

describe.skipIf(process.platform !== "win32")(
  "bootstrap read-only startup recovery facts",
  () => {
    it("listens with one pending recovery and keeps HTTP wake independent of its settlement", async () => {
      const h = await harness();
      const pending = await pendingRecovery(h.storage);
      const runtime = await h.start();
      const read = statusReader(runtime);
      await vi.waitFor(() =>
        expect(pending.reader.read.mock.calls.length).toBe(1),
      );
      const first = read();
      const expected = state(
        "pending",
        { recoveryState: "inspecting", recoveryInFlight: true },
        { activity: "busy" },
      );
      expectStatus(first, expected);
      expect(read() === first).toBe(false);
      expect(read().runner === first.runner).toBe(false);
      expect(read().adapter === first.adapter).toBe(false);
      const before = facts(h.storage);
      for (let index = 0; index < 3; index++) expectStatus(read(), expected);
      await flush();
      expect(isDeepStrictEqual(facts(h.storage), before)).toBe(true);
      expect(pending.reader.read.mock.calls.length).toBe(1);
      expect(pending.reader.close.mock.calls.length).toBe(0);
      expect(h.recoverCalls()).toBe(1);
      const authorization = `Bearer ${h.storage.initialized.credential.key}`;
      expect(
        (await call(runtime.server, authorization, "/healthz")).status,
      ).toBe(200);
      expect(
        (await call(runtime.server, authorization, "/v1/capabilities")).ready,
      ).toBe(false);
      const cancelled = call(
        runtime.server,
        authorization,
        `/v1/enhancement-jobs/${pending.accepted.job.jobId}`,
        "DELETE",
      );
      void cancelled.catch(() => {});
      await vi.waitFor(() => expect(h.wakeCalls()).toBe(1));
      expect((await cancelled).cancelRequested).toBe(true);
      expectStatus(read(), expected);
      pending.result.resolve({ kind: "unknown", cleanup: "closed" });
      await h.recovery();
      await flush();
      expectStatus(
        read(),
        state("settled", { recoveryState: "unknown" }, { activity: "unknown" }),
      );
      expectStatus(first, expected);
      expect(h.listen.mock.calls[0]![0].ready?.()).toBe(false);
      expect(h.recoverCalls()).toBe(1);
      expect(factories.host.mock.calls.length).toBe(0);
      expect(factories.journal.mock.calls.length).toBe(1);
    }, 15_000);

    it("retains the original Runner and Adapter facts through close and late recovery settlement", async () => {
      const h = await harness();
      const pending = await pendingRecovery(h.storage, true);
      const runtime = await h.start();
      const read = statusReader(runtime);
      await vi.waitFor(() =>
        expect(pending.reader.read.mock.calls.length).toBe(1),
      );
      const before = facts(h.storage);
      const first = read();
      runtime.close();
      expect(h.storage.store.closed).toBe(true);
      expect(runtime.server.listening).toBe(false);
      expectStatus(
        read(),
        state(
          "pending",
          { recoveryState: "inspecting", recoveryInFlight: true },
          { activity: "busy", close: "pending" },
          true,
        ),
      );
      runtime.close();
      expect(pending.reader.close.mock.calls.length).toBe(1);
      pending.result.resolve({ kind: "unknown", cleanup: "closed" });
      await h.recovery();
      await flush();
      expectStatus(
        read(),
        state(
          "settled",
          { recoveryState: "inspecting" },
          { activity: "unknown", close: "pending" },
          true,
        ),
      );
      pending.cleanup.resolve("unknown");
      await flush();
      expectStatus(
        read(),
        state(
          "settled",
          { recoveryState: "inspecting" },
          { activity: "cleanup_unknown", close: "unknown" },
          true,
        ),
      );
      expect(isDeepStrictEqual(facts(h.storage), before)).toBe(true);
      expect(first.closing).toBe(false);
      expect(first.startupRecovery).toBe("pending");
      expect(h.recoverCalls()).toBe(1);
      expect(h.wakeCalls()).toBe(0);
      expect(h.listen.mock.calls.length).toBe(1);
      expect(pending.reader.read.mock.calls.length).toBe(1);
      expect(pending.reader.close.mock.calls.length).toBe(1);
      expect(factories.host.mock.calls.length).toBe(0);
    }, 15_000);

    it.each(["begin-recovery", "sync-recover"] as const)(
      "exposes %s failure independently of the original idle recoveryState",
      async (failure) => {
        const h = await harness(failure);
        const log = vi.spyOn(console, "error").mockImplementation(() => {});
        const runtime = await h.start();
        const read = statusReader(runtime);
        await flush();
        expectStatus(read(), state("failed"));
        expect(h.recoverCalls()).toBe(1);
        expect(h.open.mock.calls.length).toBe(1);
        expect(h.runner.mock.calls.length).toBe(1);
        expect(h.listen.mock.calls.length).toBe(1);
        expect(h.listen.mock.calls[0]![0].ready?.()).toBe(false);
        expect(
          isDeepStrictEqual(log.mock.calls, [["enhancement_recovery_failed"]]),
        ).toBe(true);
        const authorization = `Bearer ${h.storage.initialized.credential.key}`;
        expect(
          (await call(runtime.server, authorization, "/healthz")).status,
        ).toBe(200);
        expect(
          (await call(runtime.server, authorization, "/v1/capabilities")).ready,
        ).toBe(false);
        expect(facts(h.storage).attempts.length).toBe(0);
        runtime.close();
        await flush();
        expectStatus(read(), state("failed", {}, {}, true));
        expect(factories.host.mock.calls.length).toBe(0);
        expect(factories.journal.mock.calls.length).toBe(0);
        expect(h.recoverCalls()).toBe(1);
      },
      15_000,
    );
  },
);
