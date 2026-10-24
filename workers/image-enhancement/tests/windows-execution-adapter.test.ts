import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EnhancementError } from "../src/contracts.js";
import {
  freezeExecutionPolicy,
  type ClaimedAttempt,
  type ExecutionExit,
  type OwnerDescriptor,
} from "../src/execution.js";
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
import {
  claimedAttempt,
  setValue,
} from "./windows-prepare-payload-fixtures.js";

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

function setup(attempt?: ClaimedAttempt) {
  const boundary = adapterBoundary(attempt);
  boundaries.push(boundary);
  factories.host.mockReturnValueOnce(boundary.host);
  factories.reader.mockReturnValueOnce(boundary.reader);
  const adapter = createWindowsExecutionAdapter(boundary.options);
  adapters.push(adapter);
  return { boundary, adapter };
}

function keep<T>(promise: Promise<T>): Promise<T> {
  void promise.catch(() => {});
  return promise;
}

async function prepare(
  adapter: WindowsExecutionAdapter,
  boundary: AdapterBoundary,
) {
  const permission = sendPermission();
  const pending = keep(adapter.prepare(boundary.attempt, permission.guard));
  await flushAdapter();
  // A missing feature fails at the public behavior assertion below, never at an
  // undefined fake call. The original Host is the only permit consumer.
  const allowed = boundary.host.prepare.mock.calls[0]?.[2].takeSendPermission();
  boundary.prepared.resolve({
    kind: "prepared",
    descriptor: boundary.descriptor,
  });
  await expect(pending).resolves.toEqual(boundary.descriptor);
  expect(allowed).toBe(true);
  expect(permission.guard.takeSendPermission).toHaveBeenCalledOnce();
  expect(boundary.host.prepare.mock.calls[0]?.[2]).toBe(permission.guard);
  permission.seal();
  return permission;
}

async function authorize(
  adapter: WindowsExecutionAdapter,
  boundary: AdapterBoundary,
) {
  const permission = sendPermission();
  const pending = keep(
    adapter.authorize(boundary.attempt, boundary.descriptor, permission.guard),
  );
  await flushAdapter();
  const allowed =
    boundary.host.authorize.mock.calls[0]?.[3].takeSendPermission();
  boundary.authorized.resolve({ kind: "authorized" });
  await expect(pending).resolves.toBeUndefined();
  expect(allowed).toBe(true);
  expect(permission.guard.takeSendPermission).toHaveBeenCalledOnce();
  expect(boundary.host.authorize.mock.calls[0]?.[3]).toBe(permission.guard);
  permission.seal();
  return permission;
}

async function finish(
  boundary: AdapterBoundary,
  kind: "engine-exit" | "stop" | "deadline" = "engine-exit",
) {
  const interpretation = boundary.terminal(kind);
  boundary.closed.resolve({ kind: "stopped", cleanup: "closed" });
  await flushAdapter();
  boundary.read.resolve({ kind: "read", interpretation, cleanup: "closed" });
  await flushAdapter();
  return interpretation;
}

function nextAttempt(): ClaimedAttempt {
  const original = claimedAttempt();
  return {
    ...original,
    identity: {
      ...original.identity,
      jobId: "adapter-next-job",
      fence: original.identity.fence + 1,
    },
    launchTicket: "adapter-next-ticket",
    job: { ...original.job, jobId: "adapter-next-job" },
  };
}

function changedOwner(owner: OwnerDescriptor): OwnerDescriptor {
  return { ...owner, executionId: "f".repeat(32) };
}

describe.runIf(process.platform === "win32")(
  "Windows execution Adapter",
  () => {
    it("prepares the original request and observes strict exit after both send guards are sealed", async () => {
      const { boundary: b, adapter } = setup();
      expect(adapter.kind).toBe("windows");
      expect(Object.isFrozen(adapter)).toBe(true);
      const preparePermission = await prepare(adapter, b);
      expect(b.host.prepare).toHaveBeenCalledWith(
        b.request,
        b.scope,
        preparePermission.guard,
      );
      expect(b.host.whenClosed).toHaveBeenCalledOnce();
      expect(b.host.open.mock.calls[0]?.[1]()).toBe(true);
      const seen: ExecutionExit[] = [];
      adapter.observeExit(b.scope.target, b.descriptor, (exit) =>
        seen.push(exit),
      );
      const authPermission = await authorize(adapter, b);
      expect(b.host.authorize).toHaveBeenCalledWith(
        b.scope.target,
        b.descriptor,
        b.request.requestFingerprint,
        authPermission.guard,
      );
      const terminal = b.terminal();
      b.closed.resolve({ kind: "stopped", cleanup: "closed" });
      await flushAdapter();
      const [scope, owner, signal, current] = b.reader.read.mock.calls[0]!;
      expect(scope).toEqual(b.scope);
      expect(owner).toEqual(b.descriptor);
      expect(signal.aborted).toBe(false);
      expect(current()).toBe(true);
      expect(preparePermission.guard.stillCurrent()).toBe(false);
      expect(authPermission.guard.stillCurrent()).toBe(false);
      b.read.resolve({
        kind: "read",
        interpretation: terminal,
        cleanup: "closed",
      });
      await flushAdapter();
      expect(seen).toEqual([terminal.exit]);
      expect(factories.reader).toHaveBeenCalledWith({
        executablePath: b.options.bridge.helperPath,
        recordsRoot: b.options.bridge.recordsRoot,
        environment: b.options.bridge.environment,
        limits: b.options.journalLimits,
      });
      expect(b.reader.read).toHaveBeenCalledOnce();
      expect(b.host.close).not.toHaveBeenCalled();
    });

    it("keeps a fast strict exit even when it precedes the original AUTH response", async () => {
      const { boundary: b, adapter } = setup();
      await prepare(adapter, b);
      const seen: ExecutionExit[] = [];
      adapter.observeExit(b.scope.target, b.descriptor, (exit) =>
        seen.push(exit),
      );
      const permission = sendPermission();
      const pending = keep(
        adapter.authorize(b.attempt, b.descriptor, permission.guard),
      );
      await flushAdapter();
      expect(b.host.authorize.mock.calls[0]?.[3].takeSendPermission()).toBe(
        true,
      );
      const terminal = await finish(b);
      expect(seen).toEqual([terminal.exit]);
      b.authorized.resolve({ kind: "unknown", cleanup: "closed" });
      await expect(pending).rejects.toMatchObject({ code: "not_ready" });
      permission.seal();
      expect(seen).toEqual([terminal.exit]);
    });

    it("freezes one shared bridge/helper configuration before the caller can mutate it", async () => {
      const { boundary: b, adapter } = setup();
      const expected = structuredClone(b.options);
      setValue(
        b.options.bridge,
        ["helperPath"],
        "Z:\\contract-only\\other.exe",
      );
      setValue(
        b.options.bridge,
        ["recordsRoot"],
        "Z:\\contract-only\\other-records",
      );
      setValue(b.options.bridge.environment, ["SYNTHETIC_BRIDGE"], "changed");
      await prepare(adapter, b);
      await finish(b);
      expect(factories.host).toHaveBeenCalledWith({
        ...expected.bridge,
        limits: {
          ...expected.bridge.limits,
          cleanupTimeoutMs:
            expected.bridge.limits.cleanupTimeoutMs +
            b.attempt.executionPolicy.limits.cancelGraceMs,
        },
      });
      expect(factories.reader).toHaveBeenCalledWith({
        executablePath: expected.bridge.helperPath,
        recordsRoot: expected.bridge.recordsRoot,
        environment: expected.bridge.environment,
        limits: expected.journalLimits,
      });
    });

    it.each(["insufficient", "overflow"] as const)(
      "rejects %s session budget before opening any Host",
      async (kind) => {
        const attempt = claimedAttempt();
        if (kind === "overflow") {
          setValue(
            attempt,
            ["executionPolicy"],
            freezeExecutionPolicy(
              {
                ...attempt.executionPolicy.limits,
                executionTimeoutMs: Number.MAX_SAFE_INTEGER,
                cancelGraceMs: Number.MAX_SAFE_INTEGER,
              },
              attempt.executionPolicy.allowedTiles,
            ),
          );
        }
        const b = adapterBoundary(attempt);
        boundaries.push(b);
        if (kind === "insufficient")
          setValue(b.options.bridge.limits, ["sessionTimeoutMs"], 65_029);
        factories.host.mockReturnValueOnce(b.host);
        factories.reader.mockReturnValueOnce(b.reader);
        const adapter = createWindowsExecutionAdapter(b.options);
        adapters.push(adapter);
        const permission = sendPermission();
        await expect(
          adapter.prepare(attempt, permission.guard),
        ).rejects.toBeInstanceOf(EnhancementError);
        expect(b.host.open).not.toHaveBeenCalled();
        expect(permission.guard.takeSendPermission).not.toHaveBeenCalled();
      },
    );

    it("retains an unresolved original entry instead of allocating another Host", async () => {
      const { boundary: b, adapter } = setup();
      await prepare(adapter, b);
      await expect(
        adapter.prepare(nextAttempt(), sendPermission().guard),
      ).rejects.toMatchObject({ code: "not_ready" });
      expect(factories.host).toHaveBeenCalledOnce();
      expect(b.host.open).toHaveBeenCalledOnce();
    });

    it.each(["target", "descriptor"] as const)(
      "rejects a mismatched %s without spending AUTH permission",
      async (kind) => {
        const { boundary: b, adapter } = setup();
        await prepare(adapter, b);
        const permission = sendPermission();
        const attempt = kind === "target" ? nextAttempt() : b.attempt;
        const owner =
          kind === "descriptor" ? changedOwner(b.descriptor) : b.descriptor;
        await expect(
          adapter.authorize(attempt, owner, permission.guard),
        ).rejects.toBeInstanceOf(EnhancementError);
        expect(b.host.authorize).not.toHaveBeenCalled();
        expect(permission.guard.takeSendPermission).not.toHaveBeenCalled();
        const seen = vi.fn();
        adapter.observeExit(attempt, owner, seen);
        await finish(b);
        expect(seen).not.toHaveBeenCalled();
      },
    );

    it("reports owned-alive only for the original running and resumed AUTH snapshot", async () => {
      const { boundary: b, adapter } = setup();
      await prepare(adapter, b);
      await authorize(adapter, b);
      const pending = adapter.inspect(b.scope.target, b.descriptor);
      b.inspected.resolve({ kind: "state", state: b.running() });
      await expect(pending).resolves.toEqual({
        kind: "owned-alive",
        ...b.scope.target,
        descriptor: b.descriptor,
      });
    });

    it.each(["prepared", "fingerprint", "resume"] as const)(
      "keeps a %s inspect snapshot Unknown",
      async (kind) => {
        const { boundary: b, adapter } = setup();
        await prepare(adapter, b);
        const state = { ...b.running() };
        if (kind === "prepared") {
          state.phase = "prepared";
          state.authorizationVerified = false;
          state.resumeState = "not-attempted";
        } else if (kind === "fingerprint")
          state.requestFingerprint = "f".repeat(64);
        else state.resumeState = "uncertain";
        const pending = adapter.inspect(b.scope.target, b.descriptor);
        b.inspected.resolve({ kind: "state", state });
        const result = await pending;
        expect(result).toEqual({ kind: "unknown", ...b.scope.target });
        expect(Object.isFrozen(result)).toBe(true);
      },
    );

    it("does not turn a terminal Host snapshot into an exit without strict journal evidence", async () => {
      const { boundary: b, adapter } = setup();
      await prepare(adapter, b);
      const seen = vi.fn();
      adapter.observeExit(b.scope.target, b.descriptor, seen);
      const pending = adapter.inspect(b.scope.target, b.descriptor);
      b.inspected.resolve({
        kind: "state",
        state: {
          ...b.running(),
          phase: "terminal",
          sealReason: "engine-exit",
          evidenceOutcome: "verified",
          completion: "engine-exit",
        },
      });
      await expect(pending).resolves.toEqual({
        kind: "unknown",
        ...b.scope.target,
      });
      expect(seen).not.toHaveBeenCalled();
      expect(b.reader.read).not.toHaveBeenCalled();
    });

    it("does not let a ready journal reply bypass the original Host's pending closure", async () => {
      const { boundary: b, adapter } = setup();
      await prepare(adapter, b);
      const seen = vi.fn();
      adapter.observeExit(b.scope.target, b.descriptor, seen);
      b.read.resolve({
        kind: "read",
        interpretation: b.terminal(),
        cleanup: "closed",
      });
      await flushAdapter();
      expect(seen).not.toHaveBeenCalled();
      expect(b.reader.read).not.toHaveBeenCalled();
      b.closed.resolve({ kind: "stopped", cleanup: "closed" });
      await flushAdapter();
      expect(seen).toHaveBeenCalledOnce();
    });

    it("keeps Host Unknown sticky and prevents recovery from bypassing that entry", async () => {
      const { boundary: b, adapter } = setup();
      await prepare(adapter, b);
      const seen = vi.fn();
      adapter.observeExit(b.scope.target, b.descriptor, seen);
      b.read.resolve({
        kind: "read",
        interpretation: b.terminal("interrupted"),
        cleanup: "closed",
      });
      b.closed.resolve({ kind: "unknown", cleanup: "closed" });
      await flushAdapter();
      await expect(
        adapter.inspect(b.scope.target, b.descriptor),
      ).resolves.toEqual({ kind: "unknown", ...b.scope.target });
      await expect(
        adapter.readInterruptionEvidence!(
          { target: b.scope.target, descriptor: b.descriptor },
          () => true,
        ),
      ).resolves.toBeUndefined();
      const foreign = adapterBoundary(nextAttempt());
      boundaries.push(foreign);
      await expect(
        adapter.inspect(foreign.scope.target, foreign.descriptor),
      ).resolves.toEqual({ kind: "unknown", ...foreign.scope.target });
      await expect(
        adapter.prepare(nextAttempt(), sendPermission().guard),
      ).rejects.toMatchObject({ code: "not_ready" });
      expect(seen).not.toHaveBeenCalled();
      expect(b.reader.read).not.toHaveBeenCalled();
      expect(factories.reader.mock.calls.length).toBeLessThanOrEqual(1);
      expect(factories.host).toHaveBeenCalledOnce();
    });

    it.each(["closed", "unknown"] as const)(
      "retains an unqualified reader result with %s cleanup and does not auto-retry",
      async (cleanup) => {
        const { boundary: b, adapter } = setup();
        await prepare(adapter, b);
        const seen = vi.fn();
        adapter.observeExit(b.scope.target, b.descriptor, seen);
        b.closed.resolve({ kind: "stopped", cleanup: "closed" });
        await flushAdapter();
        b.read.resolve({ kind: "unknown", cleanup });
        await flushAdapter();
        await expect(
          adapter.inspect(b.scope.target, b.descriptor),
        ).resolves.toEqual({ kind: "unknown", ...b.scope.target });
        await expect(
          adapter.prepare(nextAttempt(), sendPermission().guard),
        ).rejects.toMatchObject({ code: "not_ready" });
        expect(seen).not.toHaveBeenCalled();
        expect(b.reader.read).toHaveBeenCalledOnce();
        expect(factories.host).toHaveBeenCalledOnce();
      },
    );

    it.each(["stop", "deadline"] as const)(
      "publishes strict %s without adding a completion property",
      async (kind) => {
        const { boundary: b, adapter } = setup();
        await prepare(adapter, b);
        await authorize(adapter, b);
        const seen: ExecutionExit[] = [];
        adapter.observeExit(b.scope.target, b.descriptor, (exit) =>
          seen.push(exit),
        );
        const terminal = await finish(b, kind);
        expect(seen).toEqual([terminal.exit]);
        expect(Object.hasOwn(seen[0]!, "completion")).toBe(false);
        expect(Object.isFrozen(seen[0])).toBe(true);
      },
    );

    it.each(["soft", "force"] as const)(
      "passes the original %s stop pair and guard without treating ACK as exit",
      async (mode) => {
        const { boundary: b, adapter } = setup();
        await prepare(adapter, b);
        await authorize(adapter, b);
        const seen = vi.fn();
        adapter.observeExit(b.scope.target, b.descriptor, seen);
        const permission = sendPermission();
        const request = Object.freeze({
          mode,
          stopRequestedAt: 2_000,
          terminateAfterAt: 7_000,
        });
        const pending = keep(
          adapter.requestStop(
            b.scope.target,
            b.descriptor,
            request,
            permission.guard,
          ),
        );
        await flushAdapter();
        expect(b.host.requestStop.mock.calls[0]?.[3].takeSendPermission()).toBe(
          true,
        );
        b.stopped.resolve({ kind: "stop-requested" });
        await expect(pending).resolves.toBeUndefined();
        permission.seal();
        expect(b.host.requestStop).toHaveBeenCalledExactlyOnceWith(
          b.scope.target,
          b.descriptor,
          request,
          permission.guard,
        );
        expect(permission.guard.takeSendPermission).toHaveBeenCalledOnce();
        expect(seen).not.toHaveBeenCalled();
        expect(b.host.close).not.toHaveBeenCalled();
      },
    );

    it("preserves a missing stop ACK rejection after an independent strict stop exit", async () => {
      const { boundary: b, adapter } = setup();
      await prepare(adapter, b);
      await authorize(adapter, b);
      const seen: ExecutionExit[] = [];
      adapter.observeExit(b.scope.target, b.descriptor, (exit) =>
        seen.push(exit),
      );
      const permission = sendPermission();
      const request = Object.freeze({
        mode: "soft" as const,
        stopRequestedAt: 2_000,
        terminateAfterAt: 7_000,
      });
      const pending = keep(
        adapter.requestStop(
          b.scope.target,
          b.descriptor,
          request,
          permission.guard,
        ),
      );
      await flushAdapter();
      expect(b.host.requestStop.mock.calls[0]?.[3].takeSendPermission()).toBe(
        true,
      );
      b.stopped.resolve({ kind: "unknown", cleanup: "closed" });
      await expect(pending).rejects.toMatchObject({ code: "not_ready" });
      permission.seal();
      const terminal = await finish(b, "stop");
      expect(seen).toEqual([terminal.exit]);
      await expect(pending).rejects.toMatchObject({ code: "not_ready" });
      expect(b.host.requestStop).toHaveBeenCalledWith(
        b.scope.target,
        b.descriptor,
        request,
        permission.guard,
      );
      expect(permission.guard.takeSendPermission).toHaveBeenCalledOnce();
    });

    it("delivers once per active subscription despite callback throws and synchronous replay", async () => {
      const { boundary: b, adapter } = setup();
      await prepare(adapter, b);
      const calls: string[] = [];
      let removeSecond = () => {};
      adapter.observeExit(b.scope.target, b.descriptor, () => {
        calls.push("first");
        removeSecond();
        adapter.observeExit(b.scope.target, b.descriptor, () =>
          calls.push("replay"),
        );
        throw new Error("synthetic observer failure");
      });
      removeSecond = adapter.observeExit(b.scope.target, b.descriptor, () =>
        calls.push("removed"),
      );
      adapter.observeExit(b.scope.target, b.descriptor, () =>
        calls.push("third"),
      );
      await finish(b);
      expect(calls).toEqual(["first", "replay", "third"]);
      await flushAdapter();
      expect(calls).toEqual(["first", "replay", "third"]);
    });

    it("unsubscribe affects only its listener and leaves strict caching available for synchronous replay", async () => {
      const { boundary: b, adapter } = setup();
      await prepare(adapter, b);
      const removed = vi.fn();
      const unsubscribe = adapter.observeExit(
        b.scope.target,
        b.descriptor,
        removed,
      );
      unsubscribe();
      unsubscribe();
      const terminal = await finish(b);
      expect(removed).not.toHaveBeenCalled();
      expect(b.host.close).not.toHaveBeenCalled();
      expect(b.host.requestStop).not.toHaveBeenCalled();
      const replay = vi.fn();
      adapter.observeExit(b.scope.target, b.descriptor, replay);
      expect(replay).toHaveBeenCalledExactlyOnceWith(terminal.exit);
      expect(b.reader.read).toHaveBeenCalledOnce();
    });

    it("rechecks publication after a listener synchronously closes the Adapter", async () => {
      const { boundary: b, adapter } = setup();
      await prepare(adapter, b);
      const later = vi.fn();
      adapter.observeExit(b.scope.target, b.descriptor, () => {
        void adapter.close();
      });
      adapter.observeExit(b.scope.target, b.descriptor, later);
      b.readerClosed.resolve("closed");
      await finish(b);
      expect(later).not.toHaveBeenCalled();
    });

    it.each(["adapter", "runner"] as const)(
      "%s closure seals notifications but preserves original Host scope until join",
      async (source) => {
        const { boundary: b, adapter } = setup();
        const permission = await prepare(adapter, b);
        const seen = vi.fn();
        adapter.observeExit(b.scope.target, b.descriptor, seen);
        let closing: Promise<"closed" | "unknown">;
        if (source === "runner") {
          permission.abort();
          await flushAdapter();
          expect(b.host.close).toHaveBeenCalledOnce();
          expect(seen).not.toHaveBeenCalled();
          expect(b.host.open.mock.calls[0]?.[0].aborted).toBe(false);
          expect(b.host.open.mock.calls[0]?.[1]()).toBe(true);
          closing = adapter.close();
        } else closing = adapter.close();
        expect(adapter.close()).toBe(closing);
        await flushAdapter();
        expect(b.host.close).toHaveBeenCalledOnce();
        expect(b.host.open.mock.calls[0]?.[0].aborted).toBe(false);
        expect(b.host.open.mock.calls[0]?.[1]()).toBe(true);
        b.closed.resolve({ kind: "stopped", cleanup: "closed" });
        b.readerClosed.resolve("closed");
        await expect(closing).resolves.toBe("closed");
        await expect(
          adapter.prepare(nextAttempt(), sendPermission().guard),
        ).rejects.toMatchObject({ code: "not_ready" });
        await expect(
          adapter.inspect(b.scope.target, b.descriptor),
        ).resolves.toEqual({ kind: "unknown", ...b.scope.target });
        expect(seen).not.toHaveBeenCalled();
        expect(factories.host).toHaveBeenCalledOnce();
        expect(b.reader.read).not.toHaveBeenCalled();
      },
    );

    it("interrupts only the original Host before joining its resources without publishing an exit", async () => {
      const { boundary: b, adapter } = setup();
      await prepare(adapter, b);
      await authorize(adapter, b);
      const seen = vi.fn();
      adapter.observeExit(b.scope.target, b.descriptor, seen);
      const signal = b.host.open.mock.calls[0]![0];
      expect(typeof adapter.interrupt).toBe("function");
      b.host.close.mockImplementation(() => {
        expect(signal.aborted).toBe(true);
        return b.closed.promise;
      });
      const closing = adapter.interrupt();
      expect(signal.aborted).toBe(true);
      expect(adapter.interrupt()).toBe(closing);
      expect(adapter.close()).toBe(closing);
      let settled = false;
      void closing.then(() => { settled = true; });
      b.closed.resolve({ kind: "unknown", cleanup: "closed" });
      await flushAdapter();
      expect(settled).toBe(false);
      b.readerClosed.resolve("closed");
      await expect(closing).resolves.toBe("closed");
      await expect(adapter.prepare(nextAttempt(), sendPermission().guard))
        .rejects.toMatchObject({ code: "not_ready" });
      expect(b.host.close).toHaveBeenCalledOnce();
      expect(b.host.requestStop).not.toHaveBeenCalled();
      expect(b.reader.read).not.toHaveBeenCalled();
      expect(factories.host).toHaveBeenCalledOnce();
      expect(seen).not.toHaveBeenCalled();
    });

    it("preserves unknown original Host cleanup when the reader closes and shares the sealed close result", async () => {
      const { boundary: b, adapter } = setup();
      await prepare(adapter, b);
      const seen = vi.fn();
      adapter.observeExit(b.scope.target, b.descriptor, seen);
      const closing = adapter.close();
      expect(adapter.close()).toBe(closing);
      await flushAdapter();
      expect(b.host.close).toHaveBeenCalledOnce();
      expect(b.reader.close).toHaveBeenCalledOnce();
      b.closed.resolve({ kind: "unknown", cleanup: "unknown" });
      b.readerClosed.resolve("closed");
      await expect(closing).resolves.toBe("unknown");
      expect(adapter.close()).toBe(closing);
      await expect(adapter.close()).resolves.toBe("unknown");
      const permission = sendPermission();
      await expect(
        adapter.prepare(nextAttempt(), permission.guard),
      ).rejects.toMatchObject({ code: "not_ready" });
      expect(permission.guard.takeSendPermission).not.toHaveBeenCalled();
      await expect(
        adapter.inspect(b.scope.target, b.descriptor),
      ).resolves.toEqual({ kind: "unknown", ...b.scope.target });
      await flushAdapter();
      expect(seen).not.toHaveBeenCalled();
      expect(factories.host).toHaveBeenCalledOnce();
      expect(factories.reader).toHaveBeenCalledOnce();
      expect(b.host.close).toHaveBeenCalledOnce();
      expect(b.reader.close).toHaveBeenCalledOnce();
      expect(b.reader.read).not.toHaveBeenCalled();
    });

    it("close cancels the in-flight original reader and ignores its late strict reply", async () => {
      const { boundary: b, adapter } = setup();
      await prepare(adapter, b);
      const seen = vi.fn();
      adapter.observeExit(b.scope.target, b.descriptor, seen);
      b.closed.resolve({ kind: "stopped", cleanup: "closed" });
      await flushAdapter();
      const originalRead = b.reader.read.mock.calls[0]!;
      const closing = adapter.close();
      expect(originalRead[2].aborted).toBe(true);
      b.read.resolve({
        kind: "read",
        interpretation: b.terminal(),
        cleanup: "closed",
      });
      b.readerClosed.resolve("unknown");
      await expect(closing).resolves.toBe("unknown");
      await flushAdapter();
      expect(seen).not.toHaveBeenCalled();
      expect(b.reader.close).toHaveBeenCalledOnce();
    });

    it("replaces only a qualified entry and isolates the new execution from the retired guard", async () => {
      const { boundary: first, adapter } = setup();
      const oldPermission = await prepare(adapter, first);
      await finish(first);
      const second = adapterBoundary(nextAttempt());
      boundaries.push(second);
      factories.host.mockReturnValueOnce(second.host);
      factories.reader.mockReturnValueOnce(second.reader);
      await prepare(adapter, second);
      oldPermission.abort();
      const oldListener = vi.fn();
      adapter.observeExit(first.scope.target, first.descriptor, oldListener);
      await flushAdapter();
      expect(second.host.close).not.toHaveBeenCalled();
      expect(oldListener).not.toHaveBeenCalled();
      expect(second.host.open).toHaveBeenCalledOnce();
      expect(factories.host).toHaveBeenCalledTimes(2);
    });

    it("uses read-only single-flight recovery with the original producer and refuses a concurrent context", async () => {
      const { boundary: b, adapter } = setup();
      const first = adapter.inspect(b.scope.target, b.descriptor);
      const same = adapter.inspect(b.scope.target, b.descriptor);
      const foreign = adapterBoundary(nextAttempt());
      boundaries.push(foreign);
      await expect(
        adapter.inspect(foreign.scope.target, foreign.descriptor),
      ).resolves.toEqual({ kind: "unknown", ...foreign.scope.target });
      await expect(
        adapter.prepare(nextAttempt(), sendPermission().guard),
      ).rejects.toMatchObject({ code: "not_ready" });
      const terminal = b.terminal();
      b.read.resolve({
        kind: "read",
        interpretation: terminal,
        cleanup: "closed",
      });
      await expect(first).resolves.toEqual({
        kind: "tree-exited",
        exit: terminal.exit,
      });
      await expect(same).resolves.toEqual({
        kind: "tree-exited",
        exit: terminal.exit,
      });
      expect(terminal.exit.identity).toEqual(b.attempt.identity);
      expect(b.reader.read).toHaveBeenCalledOnce();
      expect(factories.host).not.toHaveBeenCalled();
      expect(b.host.open).not.toHaveBeenCalled();
    });

    it("returns only the complete strict interrupted records from the recovery reader", async () => {
      const { boundary: b, adapter } = setup();
      const terminal = b.terminal("interrupted");
      const current = vi.fn(() => true);
      const pending = adapter.readInterruptionEvidence!(
        { target: b.scope.target, descriptor: b.descriptor },
        current,
      );
      b.read.resolve({
        kind: "read",
        interpretation: terminal,
        cleanup: "closed",
      });
      expect(terminal.kind).toBe("interrupted");
      if (terminal.kind !== "interrupted")
        throw new Error("invalid contract fixture");
      await expect(pending).resolves.toEqual(terminal.records);
      expect(current.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(b.reader.read).toHaveBeenCalledOnce();
      expect(factories.host).not.toHaveBeenCalled();
    });

    it.each(["before", "after"] as const)(
      "requires caller current %s the interrupted recovery read",
      async (when) => {
        const { boundary: b, adapter } = setup();
        let current = when !== "before";
        const pending = adapter.readInterruptionEvidence!(
          { target: b.scope.target, descriptor: b.descriptor },
          () => current,
        );
        if (when === "after") {
          await flushAdapter();
          expect(b.reader.read).toHaveBeenCalledOnce();
          current = false;
        }
        b.read.resolve({
          kind: "read",
          interpretation: b.terminal("interrupted"),
          cleanup: "closed",
        });
        await expect(pending).resolves.toBeUndefined();
        if (when === "before") expect(b.reader.read).not.toHaveBeenCalled();
        expect(factories.host).not.toHaveBeenCalled();
      },
    );

    it.each(["engine-exit", "stop", "deadline"] as const)(
      "does not expose %s as interruption evidence",
      async (kind) => {
        const { boundary: b, adapter } = setup();
        const pending = adapter.readInterruptionEvidence!(
          { target: b.scope.target, descriptor: b.descriptor },
          () => true,
        );
        b.read.resolve({
          kind: "read",
          interpretation: b.terminal(kind),
          cleanup: "closed",
        });
        await expect(pending).resolves.toBeUndefined();
        expect(factories.host).not.toHaveBeenCalled();
      },
    );

    it("does not manufacture never-authorized from a null descriptor or absent/pre-AUTH evidence", async () => {
      const { boundary: b, adapter } = setup();
      await expect(adapter.inspect(b.scope.target, null)).resolves.toEqual({
        kind: "unknown",
        ...b.scope.target,
      });
      expect(b.reader.read).not.toHaveBeenCalled();
      const pending = adapter.inspect(b.scope.target, b.descriptor);
      b.read.resolve({
        kind: "read",
        interpretation: { kind: "unknown" },
        cleanup: "closed",
      });
      await expect(pending).resolves.toEqual({
        kind: "unknown",
        ...b.scope.target,
      });
      expect(factories.host).not.toHaveBeenCalled();
    });

    it("retains an unknown recovery reader owner instead of allocating a replacement", async () => {
      const { boundary: b, adapter } = setup();
      const pending = adapter.inspect(b.scope.target, b.descriptor);
      b.read.resolve({ kind: "unknown", cleanup: "unknown" });
      await expect(pending).resolves.toEqual({
        kind: "unknown",
        ...b.scope.target,
      });
      const foreign = adapterBoundary(nextAttempt());
      boundaries.push(foreign);
      await expect(
        adapter.inspect(foreign.scope.target, foreign.descriptor),
      ).resolves.toEqual({ kind: "unknown", ...foreign.scope.target });
      await expect(
        adapter.prepare(nextAttempt(), sendPermission().guard),
      ).rejects.toMatchObject({ code: "not_ready" });
      expect(factories.reader).toHaveBeenCalledOnce();
      expect(b.reader.read).toHaveBeenCalledOnce();
      expect(factories.host).not.toHaveBeenCalled();
    });

    it("allows a later explicit recovery inspection to reuse the same clean launcher", async () => {
      const { boundary: b, adapter } = setup();
      const terminal = b.terminal();
      b.reader.read
        .mockResolvedValueOnce({ kind: "unknown", cleanup: "closed" })
        .mockResolvedValueOnce({
          kind: "read",
          interpretation: terminal,
          cleanup: "closed",
        });
      await expect(
        adapter.inspect(b.scope.target, b.descriptor),
      ).resolves.toEqual({ kind: "unknown", ...b.scope.target });
      expect(b.reader.read).toHaveBeenCalledOnce();
      await expect(
        adapter.inspect(b.scope.target, b.descriptor),
      ).resolves.toEqual({ kind: "tree-exited", exit: terminal.exit });
      expect(b.reader.read).toHaveBeenCalledTimes(2);
      expect(factories.reader).toHaveBeenCalledOnce();
      expect(factories.host).not.toHaveBeenCalled();
    });

    it("explicit Adapter close cancels a recovery-only instance without pretending to observe runner closure", async () => {
      const { boundary: b, adapter } = setup();
      const pending = adapter.inspect(b.scope.target, b.descriptor);
      await flushAdapter();
      const read = b.reader.read.mock.calls[0]!;
      const closing = adapter.close();
      expect(adapter.close()).toBe(closing);
      expect(read[2].aborted).toBe(true);
      b.read.resolve({
        kind: "read",
        interpretation: b.terminal(),
        cleanup: "closed",
      });
      b.readerClosed.resolve("closed");
      await expect(closing).resolves.toBe("closed");
      await expect(pending).resolves.toEqual({
        kind: "unknown",
        ...b.scope.target,
      });
      expect(factories.host).not.toHaveBeenCalled();
      expect(b.reader.close).toHaveBeenCalledOnce();
      const readCount = factories.reader.mock.calls.length;
      await expect(
        adapter.inspect(b.scope.target, b.descriptor),
      ).resolves.toEqual({ kind: "unknown", ...b.scope.target });
      expect(factories.reader).toHaveBeenCalledTimes(readCount);
    });

    it("does not publish prepare diagnostic when stillCurrent synchronously aborts its guard", async () => {
      const { boundary: b, adapter } = setup();
      const permission = sendPermission();
      const pending = keep(adapter.prepare(b.attempt, permission.guard));
      await flushAdapter();
      expect(b.host.prepare).toHaveBeenCalledOnce();
      const sentGuard = b.host.prepare.mock.calls[0]![2];
      expect(sentGuard).toBe(permission.guard);
      expect(Object.isFrozen(permission.guard)).toBe(true);
      expect(sentGuard.takeSendPermission()).toBe(true);
      expect(permission.guard.signal.aborted).toBe(false);
      vi.mocked(permission.guard.stillCurrent).mockImplementationOnce(() => {
        permission.abort();
        return true;
      });
      b.prepared.resolve(Object.freeze({
        kind: "unknown",
        cleanup: "unknown",
        prepareDiagnostic: Object.freeze({
          prepareStage: "installation_open", nativeStage: "file_open", nativeErrorCode: 5,
        }),
      }));
      await expect(pending).rejects.toMatchObject({ code: "not_ready" });
      expect(permission.guard.signal.aborted).toBe(true);
      expect(adapter.status().sealed).toBe(true);
      expect(b.host.close).toHaveBeenCalled();
      expect(b.host.authorize).not.toHaveBeenCalled();
      expect(b.reader.read).not.toHaveBeenCalled();
      expect(Reflect.has(adapter.status(), "prepareDiagnostic"),
        "abort inside the caller callback must revoke diagnostic publication").toBe(false);
    });

    it("sanitizes a factory exception without leaking its underlying message", async () => {
      const { boundary: b, adapter } = setup();
      factories.host.mockReset().mockImplementation(() => {
        throw new Error("PRIVATE_FACTORY_SENTINEL");
      });
      await expect(
        adapter.prepare(b.attempt, sendPermission().guard),
      ).rejects.toMatchObject({
        name: "EnhancementError",
        code: "not_ready",
        message: "增强执行环境尚未就绪。",
      });
    });
  },
);
