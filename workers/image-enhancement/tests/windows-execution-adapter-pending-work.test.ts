import { isDeepStrictEqual } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EnhancementError } from "../src/contracts.js";
import type { ClaimedAttempt } from "../src/execution.js";
import type { createWindowsControlBridgeHost } from "../src/windows-control-bridge-host.js";
import type { WindowsControlBridgeCloseResult } from "../src/windows-control-bridge-protocol.js";
import {
  createWindowsExecutionAdapter,
  type WindowsExecutionAdapter,
  type WindowsExecutionStatus,
} from "../src/windows-execution-adapter.js";
import type { createWindowsJournalLauncher } from "../src/windows-journal-launcher.js";
import {
  adapterBoundary,
  deferred,
  flushAdapter,
  sendPermission,
  type AdapterBoundary,
} from "./windows-execution-adapter-fixtures.js";
import { claimedAttempt } from "./windows-prepare-payload-fixtures.js";

const factories = vi.hoisted(() => ({
  host: vi.fn<typeof createWindowsControlBridgeHost>(),
  reader: vi.fn<typeof createWindowsJournalLauncher>(),
}));
vi.mock("../src/windows-control-bridge-host.js", () => ({
  createWindowsControlBridgeHost: factories.host,
}));
vi.mock("../src/windows-journal-launcher.js", () => ({
  createWindowsJournalLauncher: factories.reader,
}));

const boundaries: AdapterBoundary[] = [];
const adapters: WindowsExecutionAdapter[] = [];
const releases: (() => void)[] = [];
const cleanups: (() => void)[] = [];

beforeEach(() => {
  factories.host.mockReset().mockImplementation(() => {
    throw new Error("unexpected test Host allocation");
  });
  factories.reader.mockReset().mockImplementation(() => {
    throw new Error("unexpected test reader allocation");
  });
});

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  const closing = adapters.splice(0).map((adapter) => adapter.close());
  for (const boundary of boundaries.splice(0)) boundary.release();
  await Promise.all(closing);
  await flushAdapter();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
});

function queueBoundary(attempt?: ClaimedAttempt) {
  const boundary = adapterBoundary(attempt);
  boundaries.push(boundary);
  factories.host.mockReturnValueOnce(boundary.host);
  factories.reader.mockReturnValueOnce(boundary.reader);
  return boundary;
}

function setup() {
  const boundary = queueBoundary();
  const adapter = createWindowsExecutionAdapter(boundary.options);
  adapters.push(adapter);
  return { boundary, adapter };
}

function pendingReader(subject: object) {
  const method: unknown = Reflect.get(subject, "pendingWork");
  return {
    method,
    read() {
      const value = (method as () => number).call(subject);
      expect(
        Number.isSafeInteger(value) && value >= 0,
        "pendingWork is a nonnegative safe integer",
      ).toBe(true);
      return value;
    },
  };
}

function expectStatus(
  adapter: WindowsExecutionAdapter,
  activity: WindowsExecutionStatus["activity"],
  close: WindowsExecutionStatus["close"] = "not_requested",
) {
  const snapshot = adapter.status();
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(
    isDeepStrictEqual(snapshot, {
      sealed: close !== "not_requested",
      activity,
      close,
    }),
    "original exact three-field Adapter status",
  ).toBe(true);
}

function ioCounts(b: AdapterBoundary) {
  return [
    factories.host.mock.calls.length,
    factories.reader.mock.calls.length,
    b.host.open.mock.calls.length,
    b.host.prepare.mock.calls.length,
    b.host.authorize.mock.calls.length,
    b.host.inspect.mock.calls.length,
    b.host.requestStop.mock.calls.length,
    b.host.whenClosed.mock.calls.length,
    b.host.close.mock.calls.length,
    b.reader.read.mock.calls.length,
    b.reader.close.mock.calls.length,
  ];
}

function keep<T>(promise: Promise<T>): Promise<T> {
  void promise.catch(() => {});
  return promise;
}

function hold() {
  const gate = deferred<void>();
  releases.push(() => gate.resolve());
  return gate;
}

function watchUnhandled() {
  let count = 0;
  const listener = () => {
    count += 1;
  };
  process.on("unhandledRejection", listener);
  cleanups.push(() => process.off("unhandledRejection", listener));
  return () => count;
}

async function expectNotReady(promise: Promise<unknown>) {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(
    error instanceof EnhancementError &&
      error.code === "not_ready" &&
      error.message === "增强执行环境尚未就绪。" &&
      Reflect.get(error, "cause") === undefined,
    "failure stays sanitized",
  ).toBe(true);
}

async function prepare(adapter: WindowsExecutionAdapter, b: AdapterBoundary) {
  const permission = sendPermission();
  const preparing = keep(adapter.prepare(b.attempt, permission.guard));
  await flushAdapter();
  expect(b.host.prepare.mock.calls.length).toBe(1);
  expect(b.host.prepare.mock.calls[0]?.[2].takeSendPermission()).toBe(true);
  b.prepared.resolve({ kind: "prepared", descriptor: b.descriptor });
  expect(isDeepStrictEqual(await preparing, b.descriptor)).toBe(true);
  permission.seal();
  return permission;
}

async function finish(b: AdapterBoundary) {
  b.closed.resolve({ kind: "stopped", cleanup: "closed" });
  await flushAdapter();
  const interpretation = b.terminal();
  b.read.resolve({ kind: "read", interpretation, cleanup: "closed" });
  await flushAdapter();
  return interpretation;
}

function nextAttempt(): ClaimedAttempt {
  const original = claimedAttempt();
  return {
    ...original,
    identity: {
      ...original.identity,
      jobId: "pending-next-job",
      fence: original.identity.fence + 1,
    },
    launchTicket: "pending-next-ticket",
    job: { ...original.job, jobId: "pending-next-job" },
  };
}

describe.runIf(process.platform === "win32")(
  "Windows Adapter original pending work",
  () => {
    it("reads only a local count and keeps zero separate from closure and qualification", async () => {
      const { boundary: b, adapter } = setup();
      const pending = pendingReader(adapter);
      expect(typeof pending.method, "Adapter exposes real pendingWork").toBe(
        "function",
      );
      const before = ioCounts(b);
      const now = vi.spyOn(Date, "now");
      for (let index = 0; index < 4; index++) expect(pending.read()).toBe(0);
      expect(now.mock.calls.length).toBe(0);
      now.mockRestore();
      expect(ioCounts(b)).toEqual(before);
      expectStatus(adapter, "idle");
      const unknown = await adapter.inspect(b.scope.target, null);
      expect(
        isDeepStrictEqual(unknown, { kind: "unknown", ...b.scope.target }),
      ).toBe(true);
      await flushAdapter();
      expect(pending.read()).toBe(0);
      expect(ioCounts(b)).toEqual(before);

      const closing = adapter.close();
      expect(pending.read()).toBeGreaterThan(0);
      expectStatus(adapter, "idle", "pending");
      const shared = pending.read();
      expect(adapter.close() === closing).toBe(true);
      expect(pending.read()).toBe(shared);
      await expect(closing).resolves.toBe("closed");
      await flushAdapter();
      expect(pending.read()).toBe(0);
      expectStatus(adapter, "idle", "closed");
      await expectNotReady(adapter.prepare(b.attempt, sendPermission().guard));
      await flushAdapter();
      expect(pending.read()).toBe(0);
      expect(ioCounts(b)).toEqual(before);
    });

    it("reserves prepare, Host open and AUTH before synchronous Host reentry", async () => {
      const { boundary: b, adapter } = setup();
      const pending = pendingReader(adapter);
      expect(typeof pending.method, "Adapter exposes real pendingWork").toBe(
        "function",
      );
      expect(pending.read()).toBe(0);
      const openGate = hold();
      const originalOpen = b.host.open.getMockImplementation()!;
      const reentry: number[] = [];
      b.host.whenClosed.mockImplementationOnce(() => {
        reentry.push(pending.read());
        return b.closed.promise;
      });
      b.host.open.mockImplementationOnce((signal, current) => {
        reentry.push(pending.read());
        return originalOpen(signal, current).then(async (result) => {
          await openGate.promise;
          return result;
        });
      });
      const permission = sendPermission();
      const preparing = keep(adapter.prepare(b.attempt, permission.guard));
      expect(reentry.length).toBe(2);
      expect(reentry.every((value) => value > 0)).toBe(true);
      expect(pending.read()).toBeGreaterThan(0);
      expect(b.host.prepare.mock.calls.length).toBe(0);
      openGate.resolve();
      await flushAdapter();
      expect(b.host.prepare.mock.calls[0]?.[2].takeSendPermission()).toBe(true);
      b.prepared.resolve({ kind: "prepared", descriptor: b.descriptor });
      expect(isDeepStrictEqual(await preparing, b.descriptor)).toBe(true);
      permission.seal();
      await flushAdapter();
      const beforeAuth = pending.read();
      expect(beforeAuth).toBeGreaterThan(0);
      let authReserved = false;
      let sent = false;
      b.host.authorize.mockImplementationOnce(
        (_target, _owner, _fingerprint, guard) => {
          authReserved = pending.read() > beforeAuth;
          sent = guard.takeSendPermission();
          return b.authorized.promise;
        },
      );
      const authorization = sendPermission();
      const authorizing = keep(
        adapter.authorize(b.attempt, b.descriptor, authorization.guard),
      );
      expect(authReserved).toBe(true);
      expect(sent).toBe(true);
      expect(
        vi.mocked(authorization.guard.takeSendPermission).mock.calls.length,
      ).toBe(1);
      b.authorized.resolve({ kind: "authorized" });
      await authorizing;
      authorization.seal();
      await finish(b);
      expect(pending.read()).toBe(0);
      expectStatus(adapter, "idle");
    });

    it("keeps detached whenClosed, the real journal read and synchronous notification tails pending", async () => {
      const { boundary: b, adapter } = setup();
      const pending = pendingReader(adapter);
      expect(typeof pending.method, "Adapter exposes real pendingWork").toBe(
        "function",
      );
      const unhandled = watchUnhandled();
      await prepare(adapter, b);
      await flushAdapter();
      expect(pending.read()).toBeGreaterThan(0);
      const callbacks: string[] = [];
      const notificationPending: number[] = [];
      let notificationIdle = false;
      adapter.observeExit(b.scope.target, b.descriptor, () => {
        callbacks.push("first");
        notificationPending.push(pending.read());
        notificationIdle = isDeepStrictEqual(adapter.status(), {
          sealed: false,
          activity: "idle",
          close: "not_requested",
        });
        adapter.observeExit(b.scope.target, b.descriptor, () => {
          callbacks.push("replay");
          notificationPending.push(pending.read());
        });
        throw new Error("PRIVATE_OBSERVER_SENTINEL");
      });
      adapter.observeExit(b.scope.target, b.descriptor, () => {
        callbacks.push("second");
        notificationPending.push(pending.read());
      });
      let readerReserved = false;
      b.reader.read.mockImplementationOnce(() => {
        readerReserved = pending.read() > 0;
        return b.read.promise;
      });
      b.closed.resolve({ kind: "stopped", cleanup: "closed" });
      await flushAdapter();
      expect(readerReserved).toBe(true);
      expect(b.reader.read.mock.calls.length).toBe(1);
      expect(pending.read()).toBeGreaterThan(0);
      expectStatus(adapter, "busy");
      b.read.resolve({
        kind: "read",
        interpretation: b.terminal(),
        cleanup: "closed",
      });
      await flushAdapter();
      expect(callbacks).toEqual(["first", "replay", "second"]);
      expect(notificationIdle).toBe(true);
      expect(notificationPending.length).toBe(3);
      expect(notificationPending.every((value) => value > 0)).toBe(true);
      expect(pending.read()).toBe(0);
      expectStatus(adapter, "idle");
      expect(unhandled()).toBe(0);
    });

    it("retains old inspect and stop chains after qualification and legitimate current replacement", async () => {
      const { boundary: first, adapter } = setup();
      const pending = pendingReader(adapter);
      expect(typeof pending.method, "Adapter exposes real pendingWork").toBe(
        "function",
      );
      const oldPermission = await prepare(adapter, first);
      await flushAdapter();
      const beforeInspect = pending.read();
      let inspectReserved = false;
      first.host.inspect.mockImplementationOnce(() => {
        inspectReserved = pending.read() > beforeInspect;
        return first.inspected.promise;
      });
      const inspecting = keep(
        adapter.inspect(first.scope.target, first.descriptor),
      );
      expect(inspectReserved).toBe(true);
      const beforeStop = pending.read();
      let stopReserved = false;
      let sent = false;
      first.host.requestStop.mockImplementationOnce(
        (_target, _owner, _request, guard) => {
          stopReserved = pending.read() > beforeStop;
          sent = guard.takeSendPermission();
          return first.stopped.promise;
        },
      );
      const permission = sendPermission();
      const stopping = keep(
        adapter.requestStop(
          first.scope.target,
          first.descriptor,
          { mode: "soft", stopRequestedAt: 2_000, terminateAfterAt: 7_000 },
          permission.guard,
        ),
      );
      expect(stopReserved).toBe(true);
      expect(sent).toBe(true);
      permission.seal();
      await finish(first);
      expectStatus(adapter, "idle");
      expect(pending.read()).toBeGreaterThan(0);

      const second = queueBoundary(nextAttempt());
      await prepare(adapter, second);
      await finish(second);
      oldPermission.abort();
      expectStatus(adapter, "idle");
      expect(pending.read()).toBeGreaterThan(0);
      expect(first.host.open.mock.calls[0]?.[1]()).toBe(false);
      expect(second.host.close.mock.calls.length).toBe(0);
      first.inspected.resolve({ kind: "state", state: first.running() });
      const inspected = await inspecting;
      expect(
        isDeepStrictEqual(inspected, {
          kind: "unknown",
          ...first.scope.target,
        }),
      ).toBe(true);
      await flushAdapter();
      expect(pending.read()).toBeGreaterThan(0);
      first.stopped.resolve({ kind: "stop-requested" });
      await expectNotReady(stopping);
      await flushAdapter();
      expect(pending.read()).toBe(0);
      expectStatus(adapter, "idle");
      expect(factories.host.mock.calls.length).toBe(2);
      expect(factories.reader.mock.calls.length).toBe(2);
      expect(first.host.close.mock.calls.length).toBe(0);
      expect(second.host.close.mock.calls.length).toBe(0);
    });

    it("joins one recovery read, counts interruption predicates and releases fulfilled caches", async () => {
      const { boundary: b, adapter } = setup();
      const pending = pendingReader(adapter);
      expect(typeof pending.method, "Adapter exposes real pendingWork").toBe(
        "function",
      );
      const predicatePending: number[] = [];
      let readerReserved = false;
      b.reader.read.mockImplementationOnce(() => {
        readerReserved = pending.read() > 0;
        return b.read.promise;
      });
      const evidence = keep(
        adapter.readInterruptionEvidence!(
          { target: b.scope.target, descriptor: b.descriptor },
          () => {
            predicatePending.push(pending.read());
            return true;
          },
        ),
      );
      expect(predicatePending.length).toBe(1);
      expect(predicatePending[0]! > 0).toBe(true);
      const inspecting = keep(adapter.inspect(b.scope.target, b.descriptor));
      const same = keep(adapter.inspect(b.scope.target, b.descriptor));
      await flushAdapter();
      expect(readerReserved).toBe(true);
      expect(b.reader.read.mock.calls.length).toBe(1);
      expect(factories.reader.mock.calls.length).toBe(1);
      expect(factories.host.mock.calls.length).toBe(0);
      expect(pending.read()).toBeGreaterThan(0);
      const terminal = b.terminal("interrupted");
      expect(terminal.kind === "interrupted").toBe(true);
      if (terminal.kind !== "interrupted")
        throw new Error("invalid interrupted contract fixture");
      b.read.resolve({
        kind: "read",
        interpretation: terminal,
        cleanup: "closed",
      });
      expect(isDeepStrictEqual(await evidence, terminal.records)).toBe(true);
      for (const result of await Promise.all([inspecting, same]))
        expect(
          isDeepStrictEqual(result, {
            kind: "tree-exited",
            exit: terminal.exit,
          }),
        ).toBe(true);
      await flushAdapter();
      expect(predicatePending.length).toBe(2);
      expect(predicatePending.every((value) => value > 0)).toBe(true);
      expect(pending.read()).toBe(0);
      expectStatus(adapter, "idle");

      const cached = await adapter.readInterruptionEvidence!(
        { target: b.scope.target, descriptor: b.descriptor },
        () => true,
      );
      expect(isDeepStrictEqual(cached, terminal.records)).toBe(true);
      const inspection = await adapter.inspect(b.scope.target, b.descriptor);
      expect(
        isDeepStrictEqual(inspection, {
          kind: "tree-exited",
          exit: terminal.exit,
        }),
      ).toBe(true);
      await flushAdapter();
      expect(pending.read()).toBe(0);
      expect(b.reader.read.mock.calls.length).toBe(1);
      expect(factories.reader.mock.calls.length).toBe(1);
      expect(factories.host.mock.calls.length).toBe(0);
    });

    it("keeps outstanding Host and aborted reader work after the shared close aggregate settles", async () => {
      const { boundary: b, adapter } = setup();
      const pending = pendingReader(adapter);
      expect(typeof pending.method, "Adapter exposes real pendingWork").toBe(
        "function",
      );
      await prepare(adapter, b);
      let notifications = 0;
      adapter.observeExit(b.scope.target, b.descriptor, () => {
        notifications += 1;
      });
      const inspecting = keep(adapter.inspect(b.scope.target, b.descriptor));
      b.closed.resolve({ kind: "stopped", cleanup: "closed" });
      await flushAdapter();
      expect(b.reader.read.mock.calls.length).toBe(1);
      const beforeClose = pending.read();
      const closeReentry: number[] = [];
      b.reader.close.mockImplementationOnce(() => {
        closeReentry.push(pending.read());
        return b.readerClosed.promise;
      });
      b.host.close.mockImplementationOnce(() => {
        closeReentry.push(pending.read());
        return b.closed.promise;
      });
      const closing = adapter.close();
      expect(closeReentry.length).toBe(2);
      expect(closeReentry.every((value) => value > beforeClose)).toBe(true);
      expect(b.reader.read.mock.calls[0]?.[2].aborted).toBe(true);
      expectStatus(adapter, "busy", "pending");
      const joined = pending.read();
      expect(adapter.close() === closing).toBe(true);
      expect(pending.read()).toBe(joined);
      b.readerClosed.resolve("closed");
      await expect(closing).resolves.toBe("closed");
      await flushAdapter();
      expect(pending.read()).toBeGreaterThan(0);
      expectStatus(adapter, "busy", "closed");

      b.read.resolve({
        kind: "read",
        interpretation: b.terminal(),
        cleanup: "closed",
      });
      await flushAdapter();
      expect(pending.read()).toBeGreaterThan(0);
      b.inspected.resolve({ kind: "state", state: b.running() });
      expect(
        isDeepStrictEqual(await inspecting, {
          kind: "unknown",
          ...b.scope.target,
        }),
      ).toBe(true);
      await flushAdapter();
      expect(pending.read()).toBe(0);
      expectStatus(adapter, "busy", "closed");
      expect(notifications).toBe(0);
      const settled = pending.read();
      expect(adapter.close() === closing).toBe(true);
      expect(pending.read()).toBe(settled);
      expect(b.host.close.mock.calls.length).toBe(1);
      expect(b.reader.close.mock.calls.length).toBe(1);
    });

    it("preserves a notification tail when its listener synchronously closes publication", async () => {
      const { boundary: b, adapter } = setup();
      const pending = pendingReader(adapter);
      expect(typeof pending.method, "Adapter exposes real pendingWork").toBe(
        "function",
      );
      await prepare(adapter, b);
      let inNotification = 0;
      let skipped = 0;
      let closing: Promise<"closed" | "unknown"> | undefined;
      adapter.observeExit(b.scope.target, b.descriptor, () => {
        inNotification = pending.read();
        closing = adapter.close();
      });
      adapter.observeExit(b.scope.target, b.descriptor, () => {
        skipped += 1;
      });
      await finish(b);
      expect(inNotification).toBeGreaterThan(0);
      expect(closing !== undefined).toBe(true);
      expect(skipped).toBe(0);
      expect(pending.read()).toBeGreaterThan(0);
      expectStatus(adapter, "idle", "pending");
      b.readerClosed.resolve("closed");
      await expect(closing).resolves.toBe("closed");
      await flushAdapter();
      expect(pending.read()).toBe(0);
      expectStatus(adapter, "idle", "closed");
    });

    it.each(["throw", "reject"] as const)(
      "pairs a prepare %s while retaining its original detached closeHost",
      async (failure) => {
        const { boundary: b, adapter } = setup();
        const pending = pendingReader(adapter);
        expect(typeof pending.method, "Adapter exposes real pendingWork").toBe(
          "function",
        );
        const unhandled = watchUnhandled();
        const closeReturn = deferred<WindowsControlBridgeCloseResult>();
        releases.push(() =>
          closeReturn.resolve({ kind: "unknown", cleanup: "unknown" }),
        );
        const closeReentry: number[] = [];
        b.host.close.mockImplementation(() => {
          closeReentry.push(pending.read());
          return closeReturn.promise;
        });
        let sent = false;
        b.host.prepare.mockImplementationOnce((_request, _scope, guard) => {
          sent = guard.takeSendPermission();
          if (failure === "throw") throw new Error("PRIVATE_PREPARE_SENTINEL");
          return Promise.reject(new Error("PRIVATE_PREPARE_SENTINEL"));
        });
        const permission = sendPermission();
        await expectNotReady(adapter.prepare(b.attempt, permission.guard));
        expect(sent).toBe(true);
        permission.seal();
        expect(closeReentry.length).toBe(1);
        expect(closeReentry[0]! > 0).toBe(true);
        b.closed.resolve({ kind: "stopped", cleanup: "closed" });
        await flushAdapter();
        expectStatus(adapter, "unknown");
        expect(b.reader.read.mock.calls.length).toBe(0);
        expect(pending.read()).toBeGreaterThan(0);
        closeReturn.resolve({ kind: "unknown", cleanup: "unknown" });
        await flushAdapter();
        expect(pending.read()).toBe(0);
        expectStatus(adapter, "cleanup_unknown");
        await expectNotReady(
          adapter.prepare(nextAttempt(), sendPermission().guard),
        );
        const closing = adapter.close();
        b.readerClosed.resolve("closed");
        await expect(closing).resolves.toBe("unknown");
        await flushAdapter();
        expect(pending.read()).toBe(0);
        expectStatus(adapter, "cleanup_unknown", "unknown");
        expect(unhandled()).toBe(0);
      },
    );

    it.each(["throw", "reject"] as const)(
      "pairs a recovery reader %s without losing cleanup_unknown or retrying the cache",
      async (failure) => {
        const { boundary: b, adapter } = setup();
        const pending = pendingReader(adapter);
        expect(typeof pending.method, "Adapter exposes real pendingWork").toBe(
          "function",
        );
        const unhandled = watchUnhandled();
        let readerReserved = false;
        b.reader.read.mockImplementationOnce(() => {
          readerReserved = pending.read() > 0;
          if (failure === "throw") throw new Error("PRIVATE_READER_SENTINEL");
          return Promise.reject(new Error("PRIVATE_READER_SENTINEL"));
        });
        const inspected = await adapter.inspect(b.scope.target, b.descriptor);
        expect(readerReserved).toBe(true);
        expect(
          isDeepStrictEqual(inspected, { kind: "unknown", ...b.scope.target }),
        ).toBe(true);
        await flushAdapter();
        expect(pending.read()).toBe(0);
        expectStatus(adapter, "cleanup_unknown");
        const evidence = await adapter.readInterruptionEvidence!(
          { target: b.scope.target, descriptor: b.descriptor },
          () => true,
        );
        expect(evidence === undefined).toBe(true);
        await flushAdapter();
        expect(pending.read()).toBe(0);
        expect(b.reader.read.mock.calls.length).toBe(1);
        expect(factories.host.mock.calls.length).toBe(0);
        const closing = adapter.close();
        b.readerClosed.resolve("closed");
        await expect(closing).resolves.toBe("unknown");
        await flushAdapter();
        expect(pending.read()).toBe(0);
        expectStatus(adapter, "cleanup_unknown", "unknown");
        expect(unhandled()).toBe(0);
      },
    );

    it("pairs detached Host rejection and close failures without leaking unhandled rejections", async () => {
      const { boundary: b, adapter } = setup();
      const pending = pendingReader(adapter);
      expect(typeof pending.method, "Adapter exposes real pendingWork").toBe(
        "function",
      );
      const unhandled = watchUnhandled();
      b.host.whenClosed.mockImplementationOnce(() =>
        Promise.reject(new Error("PRIVATE_WHEN_CLOSED_SENTINEL")),
      );
      await prepare(adapter, b);
      await flushAdapter();
      expect(pending.read()).toBe(0);
      expectStatus(adapter, "cleanup_unknown");
      expect(b.reader.read.mock.calls.length).toBe(0);
      const reentry: number[] = [];
      b.reader.close.mockImplementationOnce(() => {
        reentry.push(pending.read());
        throw new Error("PRIVATE_READER_CLOSE_SENTINEL");
      });
      b.host.close.mockImplementationOnce(() => {
        reentry.push(pending.read());
        return Promise.reject(new Error("PRIVATE_HOST_CLOSE_SENTINEL"));
      });
      const closing = adapter.close();
      expect(reentry.length).toBe(2);
      expect(reentry.every((value) => value > 0)).toBe(true);
      expect(pending.read()).toBeGreaterThan(0);
      expectStatus(adapter, "cleanup_unknown", "pending");
      const shared = pending.read();
      expect(adapter.close() === closing).toBe(true);
      expect(pending.read()).toBe(shared);
      await expect(closing).resolves.toBe("unknown");
      await flushAdapter();
      expect(pending.read()).toBe(0);
      expectStatus(adapter, "cleanup_unknown", "unknown");
      expect(unhandled()).toBe(0);
    });
  },
);
