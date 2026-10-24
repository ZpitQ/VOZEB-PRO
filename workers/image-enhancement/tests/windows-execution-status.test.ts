import { isDeepStrictEqual } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClaimedAttempt } from "../src/execution.js";
import type { createWindowsControlBridgeHost } from "../src/windows-control-bridge-host.js";
import {
  createWindowsExecutionAdapter,
  type WindowsExecutionAdapter,
} from "../src/windows-execution-adapter.js";
import type { createWindowsJournalLauncher } from "../src/windows-journal-launcher.js";
import {
  adapterBoundary,
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

type WindowsExecutionStatus = Readonly<{
  sealed: boolean;
  activity: "idle" | "busy" | "unknown" | "cleanup_unknown";
  close: "not_requested" | "pending" | "closed" | "unknown";
}>;

const boundaries: AdapterBoundary[] = [];
const adapters: WindowsExecutionAdapter[] = [];
beforeEach(() => {
  factories.host.mockReset().mockImplementation(() => {
    throw new Error("unexpected test Host allocation");
  });
  factories.reader.mockReset().mockImplementation(() => {
    throw new Error("unexpected test reader allocation");
  });
});
afterEach(async () => {
  const closing = adapters.splice(0).map((adapter) => adapter.close());
  for (const boundary of boundaries.splice(0)) boundary.release();
  await Promise.all(closing);
  await flushAdapter();
});

function statusReader(subject: object) {
  const status = Reflect.get(subject, "status");
  expect(typeof status, "Windows Adapter exposes its real status method").toBe(
    "function",
  );
  return () => {
    const result = (status as () => WindowsExecutionStatus).call(subject);
    expect(Object.isFrozen(result), "frozen Windows Adapter snapshot").toBe(
      true,
    );
    return result;
  };
}

function expectStatus(
  actual: WindowsExecutionStatus,
  activity: WindowsExecutionStatus["activity"],
  close: WindowsExecutionStatus["close"] = "not_requested",
) {
  expect(
    isDeepStrictEqual(actual, {
      sealed: close !== "not_requested",
      activity,
      close,
    }),
    "exact Windows Adapter status",
  ).toBe(true);
}

function setup(attempt?: ClaimedAttempt) {
  const boundary = adapterBoundary(attempt);
  boundaries.push(boundary);
  factories.host.mockReturnValueOnce(boundary.host);
  factories.reader.mockReturnValueOnce(boundary.reader);
  const adapter = createWindowsExecutionAdapter(boundary.options);
  adapters.push(adapter);
  return { boundary, adapter };
}

function keep<T>(pending: Promise<T>): Promise<T> {
  void pending.catch(() => {});
  return pending;
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

async function stableReads(
  read: () => WindowsExecutionStatus,
  b: AdapterBoundary,
  activity: WindowsExecutionStatus["activity"],
  close: WindowsExecutionStatus["close"] = "not_requested",
) {
  const before = ioCounts(b);
  const first = read();
  const second = read();
  expect(first === second).toBe(false);
  expectStatus(first, activity, close);
  expectStatus(second, activity, close);
  await flushAdapter();
  expect(ioCounts(b)).toEqual(before);
  expectStatus(first, activity, close);
}

async function prepare(adapter: WindowsExecutionAdapter, b: AdapterBoundary) {
  const permission = sendPermission();
  const pending = keep(adapter.prepare(b.attempt, permission.guard));
  await flushAdapter();
  expect(b.host.prepare.mock.calls[0]?.[2].takeSendPermission()).toBe(true);
  b.prepared.resolve({ kind: "prepared", descriptor: b.descriptor });
  expect(isDeepStrictEqual(await pending, b.descriptor)).toBe(true);
  permission.seal();
  return permission;
}

async function finish(b: AdapterBoundary) {
  b.closed.resolve({ kind: "stopped", cleanup: "closed" });
  await flushAdapter();
  b.read.resolve({
    kind: "read",
    interpretation: b.terminal(),
    cleanup: "closed",
  });
  await flushAdapter();
}

function nextAttempt(): ClaimedAttempt {
  const original = claimedAttempt();
  return {
    ...original,
    identity: {
      ...original.identity,
      jobId: "status-next-job",
      fence: original.identity.fence + 1,
    },
    launchTicket: "status-next-ticket",
    job: { ...original.job, jobId: "status-next-job" },
  };
}

describe.runIf(process.platform === "win32")(
  "Windows Adapter read-only runtime status",
  () => {
    it("stays busy until the original Host and strict reader jointly qualify", async () => {
      const { boundary: b, adapter } = setup();
      const read = statusReader(adapter);
      const initial = read();
      await stableReads(read, b, "idle");
      const permission = sendPermission();
      const preparing = keep(adapter.prepare(b.attempt, permission.guard));
      await flushAdapter();
      await stableReads(read, b, "busy");
      expect(b.reader.read).not.toHaveBeenCalled();
      await expect(
        adapter.prepare(nextAttempt(), sendPermission().guard),
      ).rejects.toMatchObject({ code: "not_ready" });
      expect(factories.host).toHaveBeenCalledOnce();
      expect(b.host.prepare.mock.calls[0]?.[2].takeSendPermission()).toBe(true);
      b.prepared.resolve({ kind: "prepared", descriptor: b.descriptor });
      await preparing;
      permission.seal();
      const authorization = sendPermission();
      const authorizing = keep(
        adapter.authorize(b.attempt, b.descriptor, authorization.guard),
      );
      await flushAdapter();
      expect(b.host.authorize.mock.calls[0]?.[3].takeSendPermission()).toBe(
        true,
      );
      await stableReads(read, b, "busy");
      b.authorized.resolve({ kind: "authorized" });
      await authorizing;
      authorization.seal();
      await stableReads(read, b, "busy");
      expect(b.reader.read).not.toHaveBeenCalled();
      b.closed.resolve({ kind: "stopped", cleanup: "closed" });
      await flushAdapter();
      await stableReads(read, b, "busy");
      expect(b.reader.read).toHaveBeenCalledOnce();
      expect(b.reader.read.mock.calls[0]?.[2].aborted).toBe(false);
      b.read.resolve({
        kind: "read",
        interpretation: b.terminal(),
        cleanup: "closed",
      });
      await flushAdapter();
      await stableReads(read, b, "idle");
      expectStatus(initial, "idle");
      expect(b.host.close).not.toHaveBeenCalled();
    });

    it("preserves a qualified strict exit before a late failed AUTH response", async () => {
      const { boundary: b, adapter } = setup();
      const read = statusReader(adapter);
      await prepare(adapter, b);
      const permission = sendPermission();
      const pending = keep(
        adapter.authorize(b.attempt, b.descriptor, permission.guard),
      );
      await flushAdapter();
      expect(b.host.authorize.mock.calls[0]?.[3].takeSendPermission()).toBe(
        true,
      );
      expectStatus(read(), "busy");
      await finish(b);
      expectStatus(read(), "idle");
      b.authorized.resolve({ kind: "unknown", cleanup: "closed" });
      await expect(pending).rejects.toMatchObject({ code: "not_ready" });
      permission.seal();
      await stableReads(read, b, "idle");
    });

    it.each([
      { source: "host", cleanup: "closed", activity: "unknown" },
      { source: "host", cleanup: "unknown", activity: "cleanup_unknown" },
      { source: "reader", cleanup: "closed", activity: "unknown" },
      { source: "reader", cleanup: "unknown", activity: "cleanup_unknown" },
      { source: "interpretation", cleanup: "closed", activity: "unknown" },
    ] as const)(
      "retains $source Unknown with $cleanup cleanup while sealing separately",
      async ({ source, cleanup, activity }) => {
        const { boundary: b, adapter } = setup();
        const read = statusReader(adapter);
        await prepare(adapter, b);
        if (source === "host") b.closed.resolve({ kind: "unknown", cleanup });
        else {
          b.closed.resolve({ kind: "stopped", cleanup: "closed" });
          await flushAdapter();
          b.read.resolve(
            source === "reader"
              ? { kind: "unknown", cleanup }
              : { kind: "read", interpretation: { kind: "unknown" }, cleanup },
          );
        }
        await flushAdapter();
        await stableReads(read, b, activity);
        expect(b.reader.read).toHaveBeenCalledTimes(source === "host" ? 0 : 1);
        await expect(
          adapter.prepare(nextAttempt(), sendPermission().guard),
        ).rejects.toMatchObject({ code: "not_ready" });
        expect(factories.host).toHaveBeenCalledOnce();
        const closing = adapter.close();
        expect(adapter.close()).toBe(closing);
        await stableReads(read, b, activity, "pending");
        b.readerClosed.resolve("closed");
        const result = activity === "cleanup_unknown" ? "unknown" : "closed";
        await expect(closing).resolves.toBe(result);
        await stableReads(read, b, activity, result);
        expect(b.host.close).toHaveBeenCalledOnce();
        expect(b.reader.close).toHaveBeenCalledOnce();
      },
    );

    it("reports stopped Host without a prepared context as unknown without starting a reader", async () => {
      const { boundary: b, adapter } = setup();
      const read = statusReader(adapter);
      const preparing = keep(
        adapter.prepare(b.attempt, sendPermission().guard),
      );
      await flushAdapter();
      b.closed.resolve({ kind: "stopped", cleanup: "closed" });
      await flushAdapter();
      await stableReads(read, b, "unknown");
      expect(b.reader.read).not.toHaveBeenCalled();
      b.prepared.resolve({ kind: "unknown", cleanup: "closed" });
      await expect(preparing).rejects.toMatchObject({ code: "not_ready" });
      expectStatus(read(), "unknown");
    });

    it.each(["closed", "unknown"] as const)(
      "caches the real shared close result %s even with no reader result",
      async (result) => {
        const { boundary: b, adapter } = setup();
        const read = statusReader(adapter);
        await prepare(adapter, b);
        const closing = adapter.close();
        expect(adapter.close()).toBe(closing);
        expectStatus(read(), "busy", "pending");
        b.closed.resolve({ kind: "stopped", cleanup: "closed" });
        await flushAdapter();
        await stableReads(read, b, "busy", "pending");
        expect(b.reader.read).not.toHaveBeenCalled();
        b.readerClosed.resolve(result);
        await expect(closing).resolves.toBe(result);
        await stableReads(
          read,
          b,
          result === "unknown" ? "cleanup_unknown" : "busy",
          result,
        );
        expect(adapter.close()).toBe(closing);
        expect(b.host.close).toHaveBeenCalledOnce();
        expect(b.reader.close).toHaveBeenCalledOnce();
      },
    );

    it("allows only a later explicit inspect to reuse the clean recovery launcher", async () => {
      const { boundary: b, adapter } = setup();
      const read = statusReader(adapter);
      b.reader.read
        .mockResolvedValueOnce({ kind: "unknown", cleanup: "closed" })
        .mockResolvedValueOnce({
          kind: "read",
          interpretation: b.terminal(),
          cleanup: "closed",
        });
      const first = adapter.inspect(b.scope.target, b.descriptor);
      expectStatus(read(), "busy");
      expect((await first).kind).toBe("unknown");
      await stableReads(read, b, "unknown");
      expect(b.reader.read).toHaveBeenCalledOnce();
      const explicit = adapter.inspect(b.scope.target, b.descriptor);
      expectStatus(read(), "busy");
      expect((await explicit).kind).toBe("tree-exited");
      await stableReads(read, b, "idle");
      expect(b.reader.read).toHaveBeenCalledTimes(2);
      expect(factories.reader).toHaveBeenCalledOnce();
      expect(factories.host).not.toHaveBeenCalled();
    });

    it("keeps retired callbacks from changing a replacement entry's busy status", async () => {
      const { boundary: first, adapter } = setup();
      const read = statusReader(adapter);
      const oldPermission = await prepare(adapter, first);
      await finish(first);
      const retired = read();
      expectStatus(retired, "idle");
      const second = adapterBoundary(nextAttempt());
      boundaries.push(second);
      factories.host.mockReturnValueOnce(second.host);
      factories.reader.mockReturnValueOnce(second.reader);
      await prepare(adapter, second);
      oldPermission.abort();
      await stableReads(read, second, "busy");
      expectStatus(retired, "idle");
      expect(second.host.close).not.toHaveBeenCalled();
      expect(factories.host).toHaveBeenCalledTimes(2);
    });
  },
);
