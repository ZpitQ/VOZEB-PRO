import { constants as bufferConstants } from "node:buffer";
import { win32 } from "node:path";
import { performance } from "node:perf_hooks";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createWindowsControlBridgeHost } from "../src/windows-control-bridge-host.js";
import { freezeWindowsPrepareRequest } from "../src/windows-prepare-payload.js";
import type { ExecutionSendGuard, OwnerDescriptor } from "../src/execution.js";
import { claimedAttempt } from "./windows-prepare-payload-fixtures.js";
import {
  decodeWindowsControlBridgeResponse,
  freezeWindowsControlBridgeOptions,
  type WindowsControlBridgeHost,
  type WindowsControlBridgeOptions,
} from "../src/windows-control-bridge-protocol.js";
import {
  controlBridgeBound,
  controlBridgeExecutionDescriptor,
  controlBridgeFixture,
  controlBridgeFlush,
  controlBridgeFrame,
  controlBridgeOptions,
  controlBridgePaddedFrame,
  controlBridgeSnapshot,
  controlBridgeTestLimits,
  syntheticExecutionId,
} from "./windows-control-bridge-host-fixtures.js";

const { spawnMock, randomBytesMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  randomBytesMock: vi.fn(),
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));
vi.mock("node:crypto", async (original) => ({
  ...(await original<typeof import("node:crypto")>()),
  randomBytes: randomBytesMock,
}));

type Run = ReturnType<typeof controlBridgeFixture>;
const runs: Run[] = [];
function fixture(scenario: Parameters<typeof controlBridgeFixture>[0] = {}) {
  const run = controlBridgeFixture(scenario);
  runs.push(run);
  spawnMock.mockImplementationOnce(() => run.child);
  return run;
}
const signal = () => new AbortController().signal;
const open = (host: WindowsControlBridgeHost) =>
  host.open(signal(), () => true);
async function bound(run: Run, host: WindowsControlBridgeHost) {
  const opening = open(host);
  run.spawn();
  run.output(run.bound());
  expect((await opening).kind).toBe("bound");
}
async function expireCleanup() {
  await vi.advanceTimersByTimeAsync(controlBridgeTestLimits.cleanupTimeoutMs);
}
function deepFrozen(value: unknown): void {
  if (!value || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) deepFrozen(child);
}

beforeEach(() => {
  spawnMock.mockReset();
  randomBytesMock.mockReset();
  let id = 0;
  randomBytesMock.mockImplementation(() =>
    Buffer.from((++id).toString(16).padStart(32, "0"), "hex"),
  );
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

describe.runIf(process.platform === "win32")(
  "original execution host permission and closure",
  () => {
    async function execution(
      scenario: Parameters<typeof controlBridgeFixture>[0] = {},
    ) {
      const run = fixture(scenario);
      run.options = controlBridgeOptions({
        limits: {
          ...controlBridgeTestLimits,
          maxRequestFrameBytes: controlBridgeTestLimits.maxResponseFrameBytes,
          maxJsonDepth: 6,
        },
      });
      const host = createWindowsControlBridgeHost(run.options);
      await bound(run, host);
      const attempt = claimedAttempt();
      const request = freezeWindowsPrepareRequest(attempt);
      const expected = {
        target: {
          identity: attempt.identity,
          launchTicket: attempt.launchTicket,
        },
        executionPolicyFingerprint: attempt.executionPolicy.fingerprint,
      };
      const descriptor = controlBridgeExecutionDescriptor(
        expected.target,
        expected.executionPolicyFingerprint,
        request.requestFingerprint,
      );
      const guard = {
        signal: signal(),
        stillCurrent: vi.fn(() => true),
        takeSendPermission: vi.fn(() => true),
      };
      const permitFor = (command: Record<string, unknown>) => ({
        v: 1,
        kind: "permit-request",
        requestId: command.requestId,
        op: command.op,
        executionId: syntheticExecutionId,
        requestFingerprint: request.requestFingerprint,
      });
      const state = (
        op: "prepare" | "authorize",
        owner: OwnerDescriptor = descriptor,
      ) =>
        controlBridgeSnapshot({
          phase: op === "prepare" ? "prepared" : "running",
          requestFingerprint: request.requestFingerprint,
          descriptor: owner,
          authorizationVerified: op === "authorize",
          resumeState: op === "prepare" ? "not-attempted" : "succeeded",
        });
      async function prepare() {
        const pending = host.prepare(request, expected, guard);
        const command = run.command();
        run.output(permitFor(command));
        run.output({
          v: 1,
          kind: "state",
          requestId: command.requestId,
          executionId: syntheticExecutionId,
          state: state("prepare"),
        });
        expect(await pending).toEqual({ kind: "prepared", descriptor });
      }
      async function end() {
        const closing = host.whenClosed();
        run.output({ v: 1, kind: "ending", executionId: syntheticExecutionId });
        run.output({
          v: 1,
          kind: "closed",
          requestId: null,
          executionId: syntheticExecutionId,
          outcome: "stopped",
        });
        await run.naturalFullJoin();
        expect(await closing).toEqual({ kind: "stopped", cleanup: "closed" });
      }
      return {
        run,
        host,
        request,
        expected,
        descriptor,
        guard,
        permitFor,
        state,
        prepare,
        end,
      };
    }

    async function business() {
      const value = await execution();
      await value.prepare();
      const pending = value.host.authorize(
        value.expected.target,
        value.descriptor,
        value.request.requestFingerprint,
        value.guard,
      );
      const auth = value.run.command();
      value.run.output(value.permitFor(auth));
      value.run.output({
        v: 1,
        kind: "state",
        requestId: auth.requestId,
        executionId: syntheticExecutionId,
        state: value.state("authorize"),
      });
      expect(await pending).toEqual({ kind: "authorized" });
      const soft = {
        mode: "soft" as const,
        stopRequestedAt: 1_000,
        terminateAfterAt: 6_000,
      };
      const force = { ...soft, mode: "force" as const };
      const guard = () => ({
        signal: signal(),
        stillCurrent: vi.fn(() => true),
        takeSendPermission: vi.fn(() => true),
      });
      const send = (
        request = soft as typeof soft | typeof force,
        permission = guard(),
      ) =>
        value.host.requestStop(
          value.expected.target,
          value.descriptor,
          request,
          permission,
        );
      const ack = (command: Record<string, unknown>) =>
        value.run.output({
          v: 1,
          kind: "state",
          requestId: command.requestId,
          executionId: syntheticExecutionId,
          state: {
            ...value.state("authorize"),
            phase: "sealed",
            sealReason: "stop",
          },
        });
      return { ...value, soft, force, guard, send, ack };
    }

    it("keeps two original stop promises and independent permits while soft ACK is held", async () => {
      const value = await business();
      const softGuard = value.guard(),
        forceGuard = value.guard();
      const soft = value.send(value.soft, softGuard),
        softCommand = value.run.command();
      expect(value.send(value.soft, value.guard())).toBe(soft);
      value.run.output(value.permitFor(softCommand));
      let softSettled = false;
      void soft.then(() => {
        softSettled = true;
      });
      const force = value.send(value.force, forceGuard),
        forceCommand = value.run.command();
      expect(value.send(value.force, value.guard())).toBe(force);
      value.run.output(value.permitFor(forceCommand));
      value.ack(forceCommand);
      expect(await force).toEqual({ kind: "stop-requested" });
      expect(softSettled).toBe(false);
      expect(value.run.streams.stdin.writableEnded).toBe(false);
      value.ack(softCommand);
      expect(await soft).toEqual({ kind: "stop-requested" });
      expect(value.send(value.soft)).toBe(soft);
      expect(value.send(value.force)).toBe(force);
      expect(softGuard.takeSendPermission).toHaveBeenCalledTimes(1);
      expect(forceGuard.takeSendPermission).toHaveBeenCalledTimes(1);
      for (const [command, request] of [
        [softCommand, value.soft],
        [forceCommand, value.force],
      ] as const)
        expect(command).toEqual({
          v: 1,
          kind: "command",
          requestId: command.requestId,
          op: "request-stop",
          executionId: syntheticExecutionId,
          target: value.expected.target,
          descriptor: value.descriptor,
          requestFingerprint: value.request.requestFingerprint,
          ...request,
        });
      await value.end();
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each(["ending", "close", "fault"])(
      "settles both original stop slots once on %s and never revives late ACK",
      async (mode) => {
        const value = await business();
        const soft = value.send(),
          softCommand = value.run.command();
        value.run.output(value.permitFor(softCommand));
        const force = value.send(value.force),
          forceCommand = value.run.command();
        value.run.output(value.permitFor(forceCommand));
        if (mode === "ending")
          value.run.output({
            v: 1,
            kind: "ending",
            executionId: syntheticExecutionId,
          });
        else if (mode === "close") void value.host.close();
        else
          value.run.output({
            v: 1,
            kind: "unknown",
            requestId: forceCommand.requestId,
            executionId: syntheticExecutionId,
          });
        const first = await soft,
          second = await force;
        expect(first.kind).toBe("unknown");
        expect(second.kind).toBe("unknown");
        value.ack(forceCommand);
        value.ack(softCommand);
        if (mode !== "fault")
          value.run.output(
            mode === "close"
              ? value.run.closedForLastCommand()
              : {
                  v: 1,
                  kind: "closed",
                  requestId: null,
                  executionId: syntheticExecutionId,
                  outcome: "stopped",
                },
          );
        await value.run.naturalFullJoin(mode === "fault" ? 2 : 0);
        await value.host.whenClosed();
        expect(await value.send()).toBe(first);
        expect(await value.send(value.force)).toBe(second);
        expect(vi.getTimerCount()).toBe(0);
      },
    );

    it.each(["false", "throw", "close", "abort", "lost"])(
      "never grants a business permit after guard %s",
      async (mode) => {
        const value = await business();
        const controller = new AbortController();
        const guard = {
          signal: controller.signal,
          stillCurrent: vi.fn(() => true),
          takeSendPermission: vi.fn(() => true),
        };
        guard.takeSendPermission.mockImplementation(() => {
          if (mode === "throw") throw new Error("test guard");
          if (mode === "close") void value.host.close();
          if (mode === "abort") controller.abort();
          if (mode === "lost") guard.stillCurrent.mockReturnValue(false);
          return mode !== "false";
        });
        const before = value.run.input.length;
        const pending = value.send(value.soft, guard);
        value.run.output(value.permitFor(value.run.command()));
        expect((await pending).kind).toBe("unknown");
        expect(guard.takeSendPermission).toHaveBeenCalledTimes(1);
        expect(
          value.run.input
            .slice(before)
            .map((bytes) => JSON.parse(bytes.toString("utf8")))
            .some((frame) => frame.kind === "permit" && frame.allow),
        ).toBe(false);
        await value.run.naturalFullJoin(2);
        await value.host.close();
      },
    );

    it("publishes the original mode slot before reentrant scope callbacks", async () => {
      const value = await business(),
        guard = value.guard();
      let entered = false,
        inner: ReturnType<typeof value.send> | undefined;
      guard.stillCurrent.mockImplementation(() => {
        if (!entered) {
          entered = true;
          inner = value.send(value.soft, guard);
        }
        return true;
      });
      const pending = value.send(value.soft, guard),
        command = value.run.command();
      expect(inner).toBe(pending);
      value.run.output(value.permitFor(command));
      value.ack(command);
      expect(await pending).toEqual({ kind: "stop-requested" });
      expect(
        value.run.input
          .map((_, index) => value.run.command(index))
          .filter(
            (frame) => frame.kind === "command" && frame.op === "request-stop",
          ),
      ).toHaveLength(1);
      await value.end();
    });

    for (const mode of ["soft", "force"] as const) {
      it.each(["admission", "current", "permission"] as const)(
        `rejects ${mode} stop across pending inspect deadline with delayed timer at %s`,
        async (stage) => {
          const value = await business();
          const anchor = performance.now();
          const clock = vi.spyOn(performance, "now").mockReturnValue(anchor);
          if (mode === "force") {
            const soft = value.send();
            const command = value.run.command();
            value.run.output(value.permitFor(command));
            value.ack(command);
            expect(await soft).toEqual({ kind: "stop-requested" });
          }
          const reading = value.host.inspect(signal(), () => true);
          let inspectSettled = false;
          void reading.then(() => {
            inspectSettled = true;
          });
          await controlBridgeFlush();
          expect(value.run.command().op).toBe("inspect");
          const before = value.run.input.length;
          const deadline = anchor + controlBridgeTestLimits.requestTimeoutMs;
          const expire = () => clock.mockReturnValue(deadline);
          clock.mockReturnValue(
            anchor + controlBridgeTestLimits.requestTimeoutMs / 2,
          );
          const guard = value.guard();
          if (stage === "admission") expire();
          if (stage === "current")
            guard.stillCurrent.mockImplementation(() => {
              expire();
              return true;
            });
          if (stage === "permission")
            guard.takeSendPermission.mockImplementation(() => {
              expire();
              return true;
            });
          // Only performance moves: the original inspect timer has not run.
          expect(inspectSettled).toBe(false);
          const request = mode === "soft" ? value.soft : value.force;
          const pending = value.send(request, guard);
          const stopCommand = value.run.input
            .slice(before)
            .map((bytes) => JSON.parse(bytes.toString("utf8")))
            .find(
              (frame) =>
                frame.kind === "command" && frame.op === "request-stop",
            );
          if (stopCommand) value.run.output(value.permitFor(stopCommand));
          await controlBridgeFlush();
          const businessFrames = value.run.input
            .slice(before)
            .map((bytes) => JSON.parse(bytes.toString("utf8")))
            .filter((frame) => frame.op === "request-stop");
          const replayGuard = value.guard();
          expect(value.send(request, replayGuard)).toBe(pending);
          await value.run.naturalFullJoin(2);
          expect(
            businessFrames.filter((frame) => frame.kind === "command"),
          ).toHaveLength(stage === "permission" ? 1 : 0);
          expect(
            businessFrames.filter((frame) => frame.kind === "permit"),
          ).toEqual([]);
          expect(guard.takeSendPermission).toHaveBeenCalledTimes(
            stage === "permission" ? 1 : 0,
          );
          expect(replayGuard.takeSendPermission).not.toHaveBeenCalled();
          expect(await reading).toEqual({
            kind: "unknown",
            cleanup: "closed",
          });
          expect(await pending).toEqual({
            kind: "unknown",
            cleanup: "unknown",
          });
          expect(await value.host.close()).toEqual({
            kind: "unknown",
            cleanup: "closed",
          });
          expect(value.run.killCount).toBe(0);
          expect(spawnMock).toHaveBeenCalledTimes(1);
        },
      );
    }

    it.each(["before-force", "force-current", "force-permission"])(
      "checks the original soft deadline despite a late timer at %s",
      async (stage) => {
        const value = await business();
        const now = performance.now();
        const clock = vi.spyOn(performance, "now").mockReturnValue(now);
        const soft = value.send();
        value.run.output(value.permitFor(value.run.command()));
        const before = value.run.input.length,
          guard = value.guard();
        const expire = () =>
          clock.mockReturnValue(now + controlBridgeTestLimits.requestTimeoutMs);
        if (stage === "before-force") expire();
        if (stage === "force-current")
          guard.stillCurrent.mockImplementation(() => {
            expire();
            return true;
          });
        if (stage === "force-permission")
          guard.takeSendPermission.mockImplementation(() => {
            expire();
            return true;
          });
        const force = value.send(value.force, guard);
        if (stage === "force-permission")
          value.run.output(value.permitFor(value.run.command()));
        expect((await soft).kind).toBe("unknown");
        expect((await force).kind).toBe("unknown");
        expect(
          value.run.input
            .slice(before)
            .map((bytes) => JSON.parse(bytes.toString("utf8")))
            .some((frame) => frame.kind === "permit" && frame.allow),
        ).toBe(false);
        await value.run.naturalFullJoin(2);
        await value.host.close();
      },
    );

    it("requires each stop command and permit write callback before its own ACK can settle", async () => {
      const value = await business();
      const soft = value.send(),
        softCommand = value.run.command();
      value.run.output(value.permitFor(softCommand));
      value.run.holdWrites();
      const force = value.send(value.force),
        forceCommand = value.run.command();
      value.run.output(value.permitFor(forceCommand));
      value.ack(forceCommand);
      let forceSettled = false,
        softSettled = false;
      void force.then(() => {
        forceSettled = true;
      });
      void soft.then(() => {
        softSettled = true;
      });
      await controlBridgeFlush();
      expect(forceSettled).toBe(false);
      value.run.settleWrite();
      await controlBridgeFlush();
      expect(forceSettled).toBe(false);
      value.run.settleWrite();
      expect(await force).toEqual({ kind: "stop-requested" });
      expect(softSettled).toBe(false);
      value.ack(softCommand);
      expect(await soft).toEqual({ kind: "stop-requested" });
      await value.end();
    });

    it.each(["requestId", "op", "requestFingerprint", "replay"])(
      "cannot reuse a business permit with wrong %s",
      async (field) => {
        const value = await business(),
          guard = value.guard();
        const soft = value.send(value.soft, guard),
          command = value.run.command();
        const permit = value.permitFor(command);
        if (field === "replay") {
          value.run.output(permit);
          value.run.output(permit);
        } else
          value.run.output({
            ...permit,
            [field]:
              field === "op"
                ? "authorize"
                : "f".repeat(field === "requestFingerprint" ? 64 : 32),
          });
        expect((await soft).kind).toBe("unknown");
        expect(guard.takeSendPermission.mock.calls.length).toBe(
          field === "replay" ? 1 : 0,
        );
        await value.run.naturalFullJoin(2);
        await value.host.close();
      },
    );

    it("reserves the original Promise before a signal listener synchronously closes", async () => {
      const value = await business(),
        guard = value.guard();
      const add = guard.signal.addEventListener.bind(guard.signal);
      let inner: ReturnType<typeof value.send> | undefined;
      vi.spyOn(guard.signal, "addEventListener").mockImplementation(
        (type, listener, options) => {
          inner = value.send(value.soft, guard);
          void value.host.close();
          add(type, listener, options);
        },
      );
      const before = value.run.input.length;
      const pending = value.send(value.soft, guard);
      expect(inner).toBe(pending);
      expect((await pending).kind).toBe("unknown");
      expect(
        value.run.input
          .slice(before)
          .map((bytes) => JSON.parse(bytes.toString("utf8")))
          .filter((frame) => frame.op === "request-stop"),
      ).toEqual([]);
      await value.run.naturalFullJoin(2);
      await value.host.close();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("rejects stop argument getters without reading them or taking permission", async () => {
      const value = await business(),
        guard = value.guard(),
        getter = vi.fn(() => "soft");
      const request = { ...value.soft };
      Object.defineProperty(request, "mode", { enumerable: true, get: getter });
      const before = value.run.input.length;
      expect((await value.send(request, guard)).kind).toBe("unknown");
      expect(getter).not.toHaveBeenCalled();
      expect(guard.takeSendPermission).not.toHaveBeenCalled();
      expect(value.run.input).toHaveLength(before);
      await value.run.naturalFullJoin(2);
      await value.host.close();
    });

    it("accepts canonical zero times and freezes caller values before dispatch", async () => {
      const value = await business(),
        guard = value.guard();
      const request = {
        mode: "soft" as const,
        stopRequestedAt: 0,
        terminateAfterAt: 5_000,
      };
      const pending = value.send(request, guard),
        command = value.run.command();
      request.stopRequestedAt = 1;
      request.terminateAfterAt = 5_001;
      expect(command).toMatchObject({
        stopRequestedAt: 0,
        terminateAfterAt: 5_000,
      });
      value.run.output(value.permitFor(command));
      value.ack(command);
      expect(await pending).toEqual({ kind: "stop-requested" });
      await value.end();
    });

    it("rejects target proxy getters without invoking them", async () => {
      const value = await business(),
        get = vi.fn();
      const target = new Proxy(value.expected.target, {
        get(source, key, receiver) {
          get();
          return Reflect.get(source, key, receiver);
        },
      });
      expect(
        (
          await value.host.requestStop(
            target,
            value.descriptor,
            value.soft,
            value.guard(),
          )
        ).kind,
      ).toBe("unknown");
      expect(get).not.toHaveBeenCalled();
      await value.run.naturalFullJoin(2);
      await value.host.close();
    });

    it.each([-1, -0, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, 1.5])(
      "rejects noncanonical stop start %s before consuming the guard",
      async (start) => {
        const value = await business(),
          guard = value.guard();
        const before = value.run.input.length;
        expect(
          (await value.send({ ...value.soft, stopRequestedAt: start }, guard))
            .kind,
        ).toBe("unknown");
        expect(guard.takeSendPermission).not.toHaveBeenCalled();
        expect(value.run.input).toHaveLength(before);
        await value.run.naturalFullJoin(2);
        await value.host.close();
      },
    );

    it("rejects a conflicting durable pair without replacing the original promise", async () => {
      const value = await business();
      const original = value.send(),
        guard = value.guard();
      expect(
        (
          await value.send(
            {
              ...value.soft,
              terminateAfterAt: value.soft.terminateAfterAt + 1,
            },
            guard,
          )
        ).kind,
      ).toBe("unknown");
      expect((await original).kind).toBe("unknown");
      expect(value.send()).toBe(original);
      expect(guard.takeSendPermission).not.toHaveBeenCalled();
      await value.run.naturalFullJoin(2);
      await value.host.close();
    });

    it("uses original canonical bytes and once-only prepare/AUTH with deeply frozen facts", async () => {
      const value = await execution();
      const {
        host,
        run,
        request,
        expected,
        descriptor,
        guard,
        permitFor,
        state,
      } = value;
      const pending = host.prepare(request, expected, guard);
      const command = run.command();
      expect(command).toMatchObject({ op: "prepare", ...request });
      expect(Object.keys(command)).toHaveLength(7);
      expect(await host.inspect(signal(), () => true)).toEqual({
        kind: "busy",
      });
      expect((await host.prepare(request, expected, guard)).kind).toBe(
        "unknown",
      );
      run.output(permitFor(command));
      expect(run.command()).toEqual({
        ...permitFor(command),
        kind: "permit",
        allow: true,
      });
      run.output({
        v: 1,
        kind: "state",
        requestId: command.requestId,
        executionId: syntheticExecutionId,
        state: state("prepare"),
      });
      const prepared = await pending;
      expect(prepared).toEqual({ kind: "prepared", descriptor });
      deepFrozen(prepared);
      // Phase guards may change after prepared metadata is committed; lifetime stays open.
      guard.stillCurrent.mockReturnValue(false);
      const authGuard = {
        signal: signal(),
        stillCurrent: () => true,
        takeSendPermission: vi.fn(() => true),
      };
      const authorizing = host.authorize(
        expected.target,
        descriptor,
        request.requestFingerprint,
        authGuard,
      );
      const auth = run.command();
      expect(Object.keys(auth)).toHaveLength(8);
      expect(auth).toMatchObject({
        op: "authorize",
        target: expected.target,
        descriptor,
      });
      run.output(permitFor(auth));
      run.output({
        v: 1,
        kind: "state",
        requestId: auth.requestId,
        executionId: syntheticExecutionId,
        state: state("authorize"),
      });
      expect(await authorizing).toEqual({ kind: "authorized" });
      expect(
        (
          await host.authorize(
            expected.target,
            descriptor,
            request.requestFingerprint,
            authGuard,
          )
        ).kind,
      ).toBe("unknown");
      expect(guard.takeSendPermission).toHaveBeenCalledTimes(1);
      expect(authGuard.takeSendPermission).toHaveBeenCalledTimes(1);
      const written = run.input.length;
      await value.end();
      expect(run.input).toHaveLength(written);
      expect(run.killCount).toBe(0);
    });

    it("passively waits through running until every original natural closure fact joins", async () => {
      vi.spyOn(performance, "now").mockReturnValue(1_000);
      const value = await execution({
        holdWrites: true,
        holdFinal: true,
        holdChildClose: true,
      });
      const { host, run } = value;
      const preparing = host.prepare(
        value.request,
        value.expected,
        value.guard,
      );
      const prepare = run.command();
      run.output(value.permitFor(prepare));
      run.output({
        v: 1,
        kind: "state",
        requestId: prepare.requestId,
        executionId: syntheticExecutionId,
        state: value.state("prepare"),
      });
      run.settleWrite();
      run.settleWrite();
      expect(await preparing).toEqual({
        kind: "prepared",
        descriptor: value.descriptor,
      });
      const authorizing = host.authorize(
        value.expected.target,
        value.descriptor,
        value.request.requestFingerprint,
        value.guard,
      );
      const auth = run.command();
      run.output(value.permitFor(auth));
      run.output({
        v: 1,
        kind: "state",
        requestId: auth.requestId,
        executionId: syntheticExecutionId,
        state: value.state("authorize"),
      });
      run.settleWrite();
      run.settleWrite();
      expect(await authorizing).toEqual({ kind: "authorized" });
      const waiting = host.whenClosed();
      let resolved = false;
      void waiting.then(() => {
        resolved = true;
      });
      expect(host.whenClosed()).toBe(waiting);
      await controlBridgeFlush();
      expect(resolved).toBe(false);
      expect(run.input).toHaveLength(4);
      expect(randomBytesMock).toHaveBeenCalledTimes(2);
      expect(run.streams.stdin.writableEnded).toBe(false);
      const reading = host.inspect(signal(), () => true);
      run.output(run.stateForLastCommand(value.state("authorize")));
      run.output({ v: 1, kind: "ending", executionId: syntheticExecutionId });
      run.output({
        v: 1,
        kind: "closed",
        requestId: null,
        executionId: syntheticExecutionId,
        outcome: "stopped",
      });
      expect(await reading).toEqual({ kind: "unknown", cleanup: "unknown" });
      run.exit();
      run.endStdout();
      await controlBridgeFlush();
      expect(run.streams.stdout.readableEnded).toBe(true);
      expect(run.streams.stderr.readableEnded).toBe(false);
      expect(resolved).toBe(false);
      run.endStderr();
      await controlBridgeFlush();
      expect(run.streams.stderr.readableEnded).toBe(true);
      expect(resolved).toBe(false);
      run.settleWrite();
      await controlBridgeFlush();
      expect(run.streams.stdin.writableFinished).toBe(false);
      expect(resolved).toBe(false);
      run.settleFinal();
      await controlBridgeFlush();
      for (const stream of run.streams.stdio) expect(stream.closed).toBe(true);
      expect(run.streams.stdin.writableFinished).toBe(true);
      expect(resolved).toBe(false);
      run.child.emit("close", 0, null);
      const result = await waiting;
      expect(result).toEqual({ kind: "stopped", cleanup: "closed" });
      deepFrozen(result);
      expect(host.whenClosed()).toBe(waiting);
      expect(host.close()).toBe(waiting);
      expect(await host.whenClosed()).toBe(result);
      expect(run.input.map((_, index) => run.command(index).op)).toEqual([
        "prepare",
        "prepare",
        "authorize",
        "authorize",
        "inspect",
      ]);
      expect(run.killCount).toBe(0);
    });

    it.each(
      ["prepare", "authorize"].flatMap((op) =>
        ["false", "throw", "reentrant-close"].map(
          (mode) => [op, mode] as const,
        ),
      ),
    )("cannot grant %s after %s", async (op, mode) => {
      const value = await execution();
      const { run, host, request, expected, descriptor, permitFor } = value;
      if (op === "authorize") await value.prepare();
      const guard = {
        signal: signal(),
        stillCurrent: () => true,
        takeSendPermission: vi.fn(() => true),
      };
      guard.takeSendPermission.mockImplementation(() => {
        if (mode === "throw") throw new Error("test guard");
        if (mode === "reentrant-close") void host.close();
        return mode !== "false";
      });
      const priorWrites = run.input.length;
      const preparing =
        op === "prepare"
          ? host.prepare(request, expected, guard)
          : host.authorize(
              expected.target,
              descriptor,
              request.requestFingerprint,
              guard,
            );
      run.output(permitFor(run.command()));
      expect((await preparing).kind).toBe("unknown");
      expect(guard.takeSendPermission).toHaveBeenCalledTimes(1);
      expect(
        run.input
          .slice(priorWrites)
          .map(
            (bytes) =>
              JSON.parse(bytes.toString("utf8")) as Record<string, unknown>,
          )
          .some((frame) => frame.kind === "permit" && frame.allow === true),
      ).toBe(false);
      await run.naturalFullJoin(2);
      await host.close();
      expect(run.killCount).toBe(0);
    });

    it("rejects an orphan permit without a queued operation", async () => {
      const value = await execution();
      value.run.output({
        v: 1,
        kind: "permit-request",
        requestId: "1".repeat(32),
        op: "prepare",
        executionId: syntheticExecutionId,
        requestFingerprint: value.request.requestFingerprint,
      });
      await value.run.naturalFullJoin(2);
      expect(value.guard.takeSendPermission).not.toHaveBeenCalled();
      expect(value.run.input).toEqual([]);
      await value.host.close();
    });

    it.each(["requestId", "op", "executionId", "requestFingerprint"])(
      "rejects a permit with another %s without taking permission",
      async (field) => {
        const { run, host, request, expected, guard, permitFor } =
          await execution();
        const preparing = host.prepare(request, expected, guard);
        run.output({
          ...permitFor(run.command()),
          [field]:
            field === "op"
              ? "authorize"
              : field === "requestFingerprint"
                ? "f".repeat(64)
                : "f".repeat(32),
        });
        await run.naturalFullJoin(2);
        expect((await preparing).kind).toBe("unknown");
        expect(guard.takeSendPermission).not.toHaveBeenCalled();
        await host.close();
      },
    );

    it("consumes permission before reentrant current callbacks can deliver another permit", async () => {
      const { run, host, request, expected, guard, permitFor } =
        await execution();
      const preparing = host.prepare(request, expected, guard);
      const permit = permitFor(run.command());
      let repeated = false;
      guard.stillCurrent.mockImplementation(() => {
        if (!repeated) {
          repeated = true;
          run.output(permit);
        }
        return true;
      });
      run.output(permit);
      await run.naturalFullJoin(2);
      expect((await preparing).kind).toBe("unknown");
      expect(guard.takeSendPermission.mock.calls.length).toBeLessThanOrEqual(1);
      await host.close();
    });

    it("drains older null observer facts without erasing a prepared binding", async () => {
      const value = await execution();
      await value.prepare();
      value.run.output({
        v: 1,
        kind: "state",
        requestId: null,
        executionId: syntheticExecutionId,
        state: controlBridgeSnapshot(),
      });
      const pending = value.host.authorize(
        value.expected.target,
        value.descriptor,
        value.request.requestFingerprint,
        value.guard,
      );
      const command = value.run.command();
      value.run.output(value.permitFor(command));
      value.run.output({
        v: 1,
        kind: "state",
        requestId: command.requestId,
        executionId: syntheticExecutionId,
        state: value.state("authorize"),
      });
      expect(await pending).toEqual({ kind: "authorized" });
      await value.end();
    });

    it("keeps a missing AUTH ACK Unknown after natural physical closure and late ACK", async () => {
      const value = await execution();
      await value.prepare();
      const closing = value.host.whenClosed();
      const pending = value.host.authorize(
        value.expected.target,
        value.descriptor,
        value.request.requestFingerprint,
        value.guard,
      );
      const command = value.run.command();
      value.run.output(value.permitFor(command));
      value.run.output({
        v: 1,
        kind: "state",
        requestId: null,
        executionId: syntheticExecutionId,
        state: controlBridgeSnapshot({
          ...value.state("authorize"),
          phase: "terminal",
          sealReason: "engine-exit",
          evidenceOutcome: "verified",
          completion: "engine-exit",
        }),
      });
      value.run.output({
        v: 1,
        kind: "ending",
        executionId: syntheticExecutionId,
      });
      const authorizationUnknown = await pending;
      expect(authorizationUnknown).toEqual({
        kind: "unknown",
        cleanup: "unknown",
      });
      value.run.output({
        v: 1,
        kind: "state",
        requestId: command.requestId,
        executionId: syntheticExecutionId,
        state: value.state("authorize"),
      });
      value.run.output({
        v: 1,
        kind: "closed",
        requestId: null,
        executionId: syntheticExecutionId,
        outcome: "stopped",
      });
      expect(value.host.close()).toBe(closing);
      await value.run.naturalFullJoin();
      expect(await closing).toEqual({ kind: "stopped", cleanup: "closed" });
      expect(value.host.whenClosed()).toBe(closing);
      expect(await pending).toBe(authorizationUnknown);
      expect(value.guard.takeSendPermission).toHaveBeenCalledTimes(2);
    });

    it("rejects a changed prepared descriptor before AUTH without taking its guard", async () => {
      const value = await execution();
      await value.prepare();
      const changed = structuredClone(value.descriptor);
      const guard: ExecutionSendGuard = {
        signal: signal(),
        stillCurrent: () => true,
        takeSendPermission: vi.fn(() => true),
      };
      const result = value.host.authorize(
        value.expected.target,
        { ...changed, details: { ...changed.details, jobName: "other-job" } },
        value.request.requestFingerprint,
        guard,
      );
      expect((await result).kind).toBe("unknown");
      expect(guard.takeSendPermission).not.toHaveBeenCalled();
      expect(
        value.run.input
          .map(
            (bytes) =>
              JSON.parse(bytes.toString("utf8")) as Record<string, unknown>,
          )
          .filter((frame) => frame.op === "authorize"),
      ).toEqual([]);
      await value.run.naturalFullJoin(2);
      await value.host.close();
    });
  },
);

describe("prepare failure diagnostic wire contract", () => {
  const diagnostic = Object.freeze({ prepareStage: "installation_open", nativeStage: "file_open", nativeErrorCode: 5 });
  const unknown = (extra: Record<string, unknown> = {}) => ({
    v: 1, kind: "unknown", requestId: "1".repeat(32), executionId: syntheticExecutionId, ...extra,
  });

  it("keeps legacy unknown and accepts only the frozen three-field prepare diagnostic", () => {
    expect(decodeWindowsControlBridgeResponse(controlBridgeFrame(unknown()), 6)).toEqual(unknown());
    const value = unknown({ prepareDiagnostic: diagnostic });
    // First intended interface RED: a valid legacy frame plus the one optional contract field.
    let accepted = false;
    let decoded: unknown;
    try { decoded = decodeWindowsControlBridgeResponse(controlBridgeFrame(value), 6); accepted = true; } catch { }
    expect(accepted, "the decoder accepts the optional prepareDiagnostic interface").toBe(true);
    expect(decoded).toEqual(value);
    deepFrozen(decoded);
    const noNative = unknown({ prepareDiagnostic: { prepareStage: "deadline", nativeStage: null, nativeErrorCode: null } });
    expect(decodeWindowsControlBridgeResponse(controlBridgeFrame(noNative), 6)).toEqual(noNative);
  });

  it.each([
    { ...diagnostic, prepareStage: "C:\\PRIVATE_STAGE" },
    { ...diagnostic, nativeStage: "C:\\PRIVATE_NATIVE" },
    { ...diagnostic, nativeErrorCode: 2_147_483_648 },
    { ...diagnostic, nativeErrorCode: -2_147_483_649 },
    { ...diagnostic, nativeErrorCode: 5.5 },
    { ...diagnostic, nativeErrorCode: true },
    { ...diagnostic, message: "PRIVATE_MESSAGE" },
    { ...diagnostic, path: "C:\\PRIVATE_PATH" },
  ])("rejects malformed or sensitive diagnostic %#", (prepareDiagnostic) => {
    expect(() => decodeWindowsControlBridgeResponse(controlBridgeFrame(unknown({ prepareDiagnostic })), 6)).toThrow();
  });

  it("rejects duplicate diagnostic keys and diagnostic on a closed frame", () => {
    const raw = JSON.stringify(unknown({ prepareDiagnostic: diagnostic })).replace('"nativeErrorCode":5', '"nativeErrorCode":5,"nativeErrorCode":5');
    expect(() => decodeWindowsControlBridgeResponse(Buffer.from(raw + "\n"), 6)).toThrow();
    expect(() => decodeWindowsControlBridgeResponse(controlBridgeFrame({
      v: 1, kind: "closed", requestId: "1".repeat(32), executionId: syntheticExecutionId,
      outcome: "unknown", prepareDiagnostic: diagnostic,
    }), 6)).toThrow();
  });
});

describe.runIf(process.platform === "win32")("prepare diagnostic original Host attribution", () => {
  const diagnostic = Object.freeze({ prepareStage: "installation_open", nativeStage: "file_open", nativeErrorCode: 5 });
  async function preparing(holdWrites: boolean) {
    const run = fixture();
    run.options = controlBridgeOptions({ limits: {
      ...controlBridgeTestLimits, maxRequestFrameBytes: controlBridgeTestLimits.maxResponseFrameBytes, maxJsonDepth: 6,
    } });
    const host = createWindowsControlBridgeHost(run.options);
    await bound(run, host);
    const heldCallbacks: (() => void)[] = [];
    if (holdWrites) {
      // Keep real stream writes flowing; defer only the original Host callbacks.
      const write = run.streams.stdin.write.bind(run.streams.stdin);
      run.streams.stdin.write = ((chunk: Buffer, callback?: (error?: Error | null) => void) =>
        write(chunk, (error) => { if (callback) heldCallbacks.push(() => callback(error)); })
      ) as typeof run.streams.stdin.write;
    }
    const attempt = claimedAttempt();
    const request = freezeWindowsPrepareRequest(attempt);
    const controller = new AbortController();
    let active = true;
    const guard = {
      signal: controller.signal,
      stillCurrent: vi.fn(() => active),
      takeSendPermission: vi.fn(() => true),
    };
    const pending = host.prepare(request, {
      target: { identity: attempt.identity, launchTicket: attempt.launchTicket },
      executionPolicyFingerprint: attempt.executionPolicy.fingerprint,
    }, guard);
    const command = run.command();
    const permit = () => run.output({
      v: 1, kind: "permit-request", requestId: command.requestId, op: "prepare",
      executionId: syntheticExecutionId, requestFingerprint: request.requestFingerprint,
    });
    const failure = (extra: Record<string, unknown> = {}) => run.output({
      v: 1, kind: "unknown", requestId: command.requestId, executionId: syntheticExecutionId,
      prepareDiagnostic: diagnostic, ...extra,
    });
    return { run, host, guard, pending, permit, failure, attempt, request, command,
      releaseWrites: () => { for (const callback of heldCallbacks.splice(0)) callback(); },
      retire: () => { active = false; }, abort: () => controller.abort() };
  }

  it.each([false, true])("attributes matched prepare unknown when callbacks are held=%s", async (held) => {
    const s = await preparing(held);
    s.permit();
    s.failure();
    if (held) {
      // Permit bytes reached the transport; both original callbacks are still withheld.
      expect(s.run.command()).toMatchObject({ kind: "permit", allow: true });
      await controlBridgeFlush();
      s.releaseWrites();
      await controlBridgeFlush();
    }
    expect(s.guard.takeSendPermission).toHaveBeenCalledTimes(1);
    await expireCleanup();
    const result = await s.pending;
    expect(result).toEqual({ kind: "unknown", cleanup: "unknown", prepareDiagnostic: diagnostic });
    deepFrozen(result);
    // Diagnostic explanation never becomes cleanup proof or a close/open/inspect field.
    expect(await s.host.whenClosed()).toEqual({ kind: "unknown", cleanup: "unknown" });
    expect(await s.host.close()).toEqual({ kind: "unknown", cleanup: "unknown" });
    expect(Reflect.has(await s.host.inspect(signal(), () => true), "prepareDiagnostic")).toBe(false);
  });

  it.each([false, true])("keeps prepare diagnostic after the matched observer Unknown with held callbacks=%s", async (held) => {
    const s = await preparing(held);
    s.permit();
    s.run.output({ v: 1, kind: "state", requestId: null, executionId: syntheticExecutionId,
      state: controlBridgeSnapshot({ phase: "unknown", sealReason: "launch-failure", requestFingerprint: s.request.requestFingerprint,
        descriptor: null, authorizationVerified: false, resumeState: "not-attempted", evidenceOutcome: "unknown", completion: null }) });
    s.failure();
    if (held) {
      await controlBridgeFlush();
      s.releaseWrites();
      await controlBridgeFlush();
    }
    await expireCleanup();
    expect(await s.pending).toEqual({ kind: "unknown", cleanup: "unknown", prepareDiagnostic: diagnostic });
    expect(await s.host.whenClosed()).toEqual({ kind: "unknown", cleanup: "unknown" });
  });

  it.each(["wrong-request", "wrong-execution", "no-permit", "retired", "aborted"] as const)(
    "does not publish diagnostic for %s", async (mode) => {
      const s = await preparing(mode === "retired");
      if (mode !== "no-permit") s.permit();
      s.failure(mode === "wrong-request" ? { requestId: "f".repeat(32) } :
        mode === "wrong-execution" ? { executionId: "f".repeat(32) } : {});
      if (mode === "retired") {
        // Retire after the diagnostic matched, before either held callback returns.
        s.retire();
        await controlBridgeFlush();
        s.releaseWrites();
        await controlBridgeFlush();
      }
      if (mode === "aborted") s.abort();
      await expireCleanup();
      const result = await s.pending;
      expect(result.kind).toBe("unknown");
      expect(Reflect.has(result, "prepareDiagnostic")).toBe(false);
      expect(Reflect.has(await s.host.whenClosed(), "prepareDiagnostic")).toBe(false);
    },
  );

  it("does not retrofit a late diagnostic onto an already settled prepare", async () => {
    const s = await preparing(false);
    s.permit();
    const owner = controlBridgeExecutionDescriptor({
      identity: s.attempt.identity, launchTicket: s.attempt.launchTicket,
    }, s.attempt.executionPolicy.fingerprint, s.request.requestFingerprint);
    s.run.output({ v: 1, kind: "state", requestId: s.command.requestId, executionId: syntheticExecutionId,
      state: controlBridgeSnapshot({ phase: "prepared", requestFingerprint: s.request.requestFingerprint,
        descriptor: owner, authorizationVerified: false, resumeState: "not-attempted" }) });
    const prepared = await s.pending;
    expect(prepared).toEqual({ kind: "prepared", descriptor: owner });
    s.failure();
    await expireCleanup();
    expect(Reflect.has(prepared, "prepareDiagnostic")).toBe(false);
    expect(Reflect.has(await s.host.whenClosed(), "prepareDiagnostic")).toBe(false);
  });

  it("does not attach diagnostic to a matched inspect instead of prepare", async () => {
    const run = fixture();
    const host = createWindowsControlBridgeHost(run.options);
    await bound(run, host);
    const pending = host.inspect(signal(), () => true);
    const command = run.command();
    run.output({ v: 1, kind: "unknown", requestId: command.requestId,
      executionId: syntheticExecutionId, prepareDiagnostic: diagnostic });
    await expireCleanup();
    expect(Reflect.has(await pending, "prepareDiagnostic")).toBe(false);
    expect(Reflect.has(await host.whenClosed(), "prepareDiagnostic")).toBe(false);
  });
});
afterEach(() => {
  for (const run of runs.splice(0)) run.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("bounded control-bridge response decoder", () => {
  it("accepts a scoped request-stop permit without broadening its exact shape", () => {
    const permit = {
      v: 1,
      kind: "permit-request",
      requestId: "1".repeat(32),
      op: "request-stop",
      executionId: syntheticExecutionId,
      requestFingerprint: "2".repeat(64),
    };
    expect(
      decodeWindowsControlBridgeResponse(controlBridgeFrame(permit), 6),
    ).toEqual(permit);
    expect(() =>
      decodeWindowsControlBridgeResponse(
        controlBridgeFrame({ ...permit, mode: "soft" }),
        6,
      ),
    ).toThrow();
  });
  it("preserves canonical UInt64 text and freezes the full binding", () => {
    const value = decodeWindowsControlBridgeResponse(
      controlBridgeFrame(controlBridgeBound()),
      4,
    );
    expect(value).toEqual(controlBridgeBound());
    deepFrozen(value);
  });

  it.each([
    [
      "noncanonical version",
      (text: string) => text.replace('"v":1', '"v":1.0'),
    ],
    ["exponent version", (text: string) => text.replace('"v":1', '"v":1e0')],
    ["string version", (text: string) => text.replace('"v":1', '"v":"1"')],
    ["unknown version", (text: string) => text.replace('"v":1', '"v":2')],
    [
      "duplicate root key",
      (text: string) => text.replace('"v":1', '"v":1,"v":1'),
    ],
    [
      "escaped duplicate key",
      (text: string) => text.replace('"v":1', '"v":1,"\\u0076":1'),
    ],
    [
      "duplicate nested key",
      (text: string) => text.replace('"pid":12001', '"pid":12001,"pid":12001'),
    ],
    [
      "noncanonical pid",
      (text: string) => text.replace('"pid":12001', '"pid":12001.0'),
    ],
    [
      "UInt32 overflow",
      (text: string) => text.replace('"pid":12001', '"pid":4294967296'),
    ],
    [
      "UInt64 overflow",
      (text: string) =>
        text.replace("9007199254740993", "18446744073709551616"),
    ],
    [
      "FILETIME zero prefix",
      (text: string) => text.replace("9007199254740993", "09007199254740993"),
    ],
    ["NUL", (text: string) => text.replace('"claimed"', '"claimed\\u0000"')],
    [
      "unpaired surrogate",
      (text: string) => text.replace('"claimed"', '"\\ud800"'),
    ],
    ["BOM", (text: string) => `\ufeff${text}`],
    ["CR", (text: string) => text.replaceAll("\n", "\r\n")],
    ["partial EOF", (text: string) => text.slice(0, -1)],
    ["suffix", (text: string) => `${text.trim()}{}\n`],
    ["comment", (text: string) => text.replace('"v":1', '"v":1/*x*/')],
    ["trailing comma", (text: string) => text.replace('"v":1,', '"v":1,,')],
    [
      "illegal snapshot",
      (text: string) => text.replace('"phase":"claimed"', '"phase":"sealed"'),
    ],
    [
      "illegal authorization",
      (text: string) =>
        text.replace(
          '"authorizationVerified":false',
          '"authorizationVerified":true',
        ),
    ],
  ])("rejects %s", (_name, change) => {
    const bytes = Buffer.from(
      change(controlBridgeFrame(controlBridgeBound()).toString("utf8")),
    );
    expect(() => decodeWindowsControlBridgeResponse(bytes, 4)).toThrow();
  });

  it("enforces depth before deep parsing and rejects fatal UTF8", () => {
    const deep = Buffer.from(
      `{"v":1,"a":${"[".repeat(50_000)}0${"]".repeat(50_000)}}\n`,
    );
    expect(() => decodeWindowsControlBridgeResponse(deep, 4)).toThrow();
    expect(() =>
      decodeWindowsControlBridgeResponse(
        Buffer.from([0x7b, 0xff, 0x7d, 0x0a]),
        4,
      ),
    ).toThrow();
  });
});

describe.runIf(process.platform === "win32")(
  "bounded control-bridge host contract",
  () => {
    it("copies and deeply freezes configuration without inherited values", async () => {
      const run = fixture();
      const options = controlBridgeOptions();
      Object.setPrototypeOf(options.environment, {
        INHERITED: "must-not-send",
      });
      const frozen = freezeWindowsControlBridgeOptions(options);
      deepFrozen(frozen);
      const host = createWindowsControlBridgeHost(options);
      (options.environment as Record<string, string>).SYNTHETIC_BRIDGE =
        "changed";
      const opening = open(host);
      run.spawn();
      run.output(run.bound());
      await opening;
      const call = spawnMock.mock.calls[0]!;
      expect(call).toEqual([
        options.executablePath,
        [
          "--control-bridge",
          JSON.stringify({
            v: 1,
            helperPath: options.helperPath,
            recordsRoot: options.recordsRoot,
            installationRoot: options.installationRoot,
            expectedManifestSha256: options.expectedManifestSha256,
            environment: { SYNTHETIC_BRIDGE: "test-only 🪑" },
            limits: controlBridgeTestLimits,
          }),
        ],
        {
          cwd: win32.dirname(options.executablePath),
          env: { SYNTHETIC_BRIDGE: "test-only 🪑" },
          shell: false,
          windowsHide: true,
          windowsVerbatimArguments: false,
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
        },
      ]);
      const closing = host.close();
      run.output(run.closedForLastCommand());
      await run.naturalFullJoin();
      expect(await closing).toEqual({ kind: "stopped", cleanup: "closed" });
    });

    it.each([
      [
        "extra key",
        (o: WindowsControlBridgeOptions) => Object.assign(o, { extra: 1 }),
      ],
      [
        "missing key",
        (o: WindowsControlBridgeOptions) => {
          Reflect.deleteProperty(o, "helperPath");
          return o;
        },
      ],
      [
        "symbol key",
        (o: WindowsControlBridgeOptions) => Object.assign(o, { [Symbol()]: 1 }),
      ],
      [
        "relative path",
        (o: WindowsControlBridgeOptions) => ({
          ...o,
          helperPath: "helper.exe",
        }),
      ],
      [
        "UNC path",
        (o: WindowsControlBridgeOptions) => ({
          ...o,
          recordsRoot: "\\\\server\\share",
        }),
      ],
      [
        "wrong extension",
        (o: WindowsControlBridgeOptions) => ({
          ...o,
          executablePath: "Z:\\fixture\\bridge.cmd",
        }),
      ],
      [
        "malformed Unicode",
        (o: WindowsControlBridgeOptions) => ({
          ...o,
          installationRoot: "Z:\\fixture\\\ud800",
        }),
      ],
      [
        "NUL",
        (o: WindowsControlBridgeOptions) => ({
          ...o,
          recordsRoot: "Z:\\fixture\u0000",
        }),
      ],
      [
        "manifest case",
        (o: WindowsControlBridgeOptions) => ({
          ...o,
          expectedManifestSha256: "A".repeat(64),
        }),
      ],
      [
        "case collision",
        (o: WindowsControlBridgeOptions) => ({
          ...o,
          environment: { Path: "x", PATH: "y" },
        }),
      ],
      [
        "empty env name",
        (o: WindowsControlBridgeOptions) => ({
          ...o,
          environment: { "": "x" },
        }),
      ],
      [
        "equals env name",
        (o: WindowsControlBridgeOptions) => ({
          ...o,
          environment: { "A=B": "x" },
        }),
      ],
      [
        "too-large bytes",
        (o: WindowsControlBridgeOptions) => ({
          ...o,
          limits: { ...o.limits, maxSessionInputBytes: 0x7fffffc8 },
        }),
      ],
      [
        "bad depth",
        (o: WindowsControlBridgeOptions) => ({
          ...o,
          limits: { ...o.limits, maxJsonDepth: 1 },
        }),
      ],
      [
        "bad timeout",
        (o: WindowsControlBridgeOptions) => ({
          ...o,
          limits: { ...o.limits, startupTimeoutMs: 0 },
        }),
      ],
      [
        "bad relationship",
        (o: WindowsControlBridgeOptions) => ({
          ...o,
          limits: { ...o.limits, maxQueuedOutputBytes: 1 },
        }),
      ],
    ])("rejects %s without spawn", (_name, change) => {
      expect(() =>
        createWindowsControlBridgeHost(change(controlBridgeOptions())),
      ).toThrow();
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it("does not invoke configuration accessors", () => {
      const options = controlBridgeOptions();
      const getter = vi.fn(() => "private");
      Object.defineProperty(options.environment, "SECRET", {
        get: getter,
        enumerable: true,
      });
      expect(() => createWindowsControlBridgeHost(options)).toThrow();
      expect(getter).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it("accepts the native byte maximum without allocating that amount", () => {
      const maximum = Math.min(bufferConstants.MAX_LENGTH, 0x7fffffc7);
      const limits = {
        ...controlBridgeTestLimits,
        maxRequestFrameBytes: maximum,
        maxSessionInputBytes: maximum,
        maxResponseFrameBytes: maximum,
        maxSessionOutputBytes: maximum,
        maxQueuedOutputBytes: maximum,
        maxHelperStderrBytes: maximum,
      };
      deepFrozen(
        freezeWindowsControlBridgeOptions(controlBridgeOptions({ limits })),
      );
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it("observes bound admission without a reverse close or stdin EOF", async () => {
      const run = fixture();
      const host = createWindowsControlBridgeHost(run.options);
      const beforeOpen = host.whenClosed();
      let resolved = false;
      void beforeOpen.then(() => {
        resolved = true;
      });
      expect(host.whenClosed()).toBe(beforeOpen);
      await controlBridgeFlush();
      expect(resolved).toBe(false);
      expect(spawnMock).not.toHaveBeenCalled();
      expect(randomBytesMock).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(run.input).toEqual([]);
      expect(run.streams.stdin.writableEnded).toBe(false);
      await bound(run, host);
      const timers = vi.getTimerCount();
      const waiting = host.whenClosed();
      expect(waiting).toBe(beforeOpen);
      expect(host.whenClosed()).toBe(waiting);
      await controlBridgeFlush();
      expect(resolved).toBe(false);
      expect(vi.getTimerCount()).toBe(timers);
      expect(randomBytesMock).not.toHaveBeenCalled();
      expect(run.input.map((_, index) => run.command(index).op)).toEqual([]);
      expect(run.streams.stdin.writableEnded).toBe(false);
      const reading = host.inspect(signal(), () => true);
      expect(run.command().op).toBe("inspect");
      run.output(run.stateForLastCommand());
      expect(await reading).toEqual({
        kind: "state",
        state: controlBridgeSnapshot(),
      });
      const closing = host.close();
      expect(closing).toBe(waiting);
      expect(host.close()).toBe(waiting);
      expect(host.whenClosed()).toBe(waiting);
      expect(run.input).toHaveLength(2);
      expect(run.command().op).toBe("close");
      expect(randomBytesMock).toHaveBeenCalledTimes(2);
      run.output(run.closedForLastCommand());
      await run.naturalFullJoin();
      expect(await waiting).toEqual({ kind: "stopped", cleanup: "closed" });
      expect(run.killCount).toBe(0);
    });

    it("waits for actual original dual EOF and all closes after terminal", async () => {
      const run = fixture();
      const host = createWindowsControlBridgeHost(run.options);
      await bound(run, host);
      const closing = host.close();
      run.output(run.closedForLastCommand());
      let resolved = false;
      void closing.then(() => {
        resolved = true;
      });
      await controlBridgeFlush();
      expect(resolved).toBe(false);
      run.exit();
      run.endStdout();
      await controlBridgeFlush();
      expect(resolved).toBe(false);
      run.endStderr();
      await run.joinAllCloses();
      const result = await closing;
      expect(result).toEqual({ kind: "stopped", cleanup: "closed" });
      deepFrozen(result);
      expect(run.killCount).toBe(0);
    });

    it("keeps Unknown sticky after cleanup deadline and a late full join", async () => {
      const run = fixture();
      const host = createWindowsControlBridgeHost(run.options);
      await bound(run, host);
      const waiting = host.whenClosed();
      const closing = host.close();
      expect(closing).toBe(waiting);
      expect(host.close()).toBe(closing);
      await expireCleanup();
      const unknown = await closing;
      expect(unknown).toEqual({ kind: "unknown", cleanup: "unknown" });
      deepFrozen(unknown);
      expect(host.whenClosed()).toBe(waiting);
      expect(await host.whenClosed()).toBe(unknown);
      run.output(run.closedForLastCommand());
      await run.naturalFullJoin();
      expect(await host.close()).toBe(unknown);
      expect(await host.whenClosed()).toBe(unknown);
      expect(run.input).toHaveLength(1);
      expect((await open(host)).kind).toBe("unknown");
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(run.killCount).toBe(0);
    });

    it("correlates one inspect and returns busy without a second write", async () => {
      const run = fixture();
      const host = createWindowsControlBridgeHost(run.options);
      await bound(run, host);
      const reading = host.inspect(signal(), () => true);
      expect(await host.inspect(signal(), () => true)).toEqual({
        kind: "busy",
      });
      expect(run.input).toHaveLength(1);
      run.output({
        v: 1,
        kind: "state",
        requestId: null,
        executionId: syntheticExecutionId,
        state: controlBridgeSnapshot(),
      });
      let resolved = false;
      void reading.then(() => {
        resolved = true;
      });
      await controlBridgeFlush();
      expect(resolved).toBe(false);
      run.output(run.stateForLastCommand());
      expect(await reading).toEqual({
        kind: "state",
        state: controlBridgeSnapshot(),
      });
      const closing = host.close();
      run.output(run.closedForLastCommand());
      await run.naturalFullJoin();
      expect(await closing).toEqual({ kind: "stopped", cleanup: "closed" });
    });

    it("preempts inspect without poisoning a normal complete close", async () => {
      const run = fixture();
      const host = createWindowsControlBridgeHost(run.options);
      await bound(run, host);
      const reading = host.inspect(signal(), () => true);
      const late = run.stateForLastCommand();
      const closing = host.close();
      expect(await reading).toEqual({ kind: "unknown", cleanup: "unknown" });
      expect(run.input).toHaveLength(2);
      expect(run.command().op).toBe("close");
      run.output(late);
      run.output(run.closedForLastCommand());
      await run.naturalFullJoin();
      expect(await closing).toEqual({ kind: "stopped", cleanup: "closed" });
    });

    it("expired pending inspect before close with delayed timer", async () => {
      const clock = vi.spyOn(performance, "now").mockReturnValue(1_000);
      const run = fixture();
      const host = createWindowsControlBridgeHost(run.options);
      await bound(run, host);
      const reading = host.inspect(signal(), () => true);
      await controlBridgeFlush();
      expect(run.command().op).toBe("inspect");
      clock.mockReturnValue(1_081);
      const closing = host.close();
      // Only the vulnerable implementation emits this valid close command.
      if (run.command().op === "close") run.output(run.closedForLastCommand());
      await run.naturalFullJoin();
      expect(await closing).toEqual({ kind: "unknown", cleanup: "closed" });
      expect((await reading).kind).toBe("unknown");
      expect(run.input).toHaveLength(1);
      expect(run.killCount).toBe(0);
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    it("pending inspect deadline crossed inside close scope callback", async () => {
      const clock = vi.spyOn(performance, "now").mockReturnValue(1_000);
      const run = fixture();
      const host = createWindowsControlBridgeHost(run.options);
      let cross = false;
      const opening = host.open(signal(), () => {
        if (cross) clock.mockReturnValue(1_081);
        return true;
      });
      run.spawn();
      run.output(run.bound());
      await opening;
      const reading = host.inspect(signal(), () => true);
      await controlBridgeFlush();
      expect(run.command().op).toBe("inspect");
      cross = true;
      const closing = host.close();
      if (run.command().op === "close") run.output(run.closedForLastCommand());
      await run.naturalFullJoin();
      expect(await closing).toEqual({ kind: "unknown", cleanup: "closed" });
      expect((await reading).kind).toBe("unknown");
      expect(run.input).toHaveLength(1);
      expect(run.killCount).toBe(0);
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    it("handles byte fragments and several frames in one chunk", async () => {
      const run = fixture();
      const host = createWindowsControlBridgeHost(run.options);
      const opening = open(host);
      run.spawn();
      const bytes = controlBridgeFrame(run.bound());
      for (const byte of bytes) run.bytes(Buffer.from([byte]));
      await opening;
      const reading = host.inspect(signal(), () => true);
      const observer = {
        v: 1,
        kind: "state",
        requestId: null,
        executionId: syntheticExecutionId,
        state: controlBridgeSnapshot(),
      };
      run.bytes(
        Buffer.concat([
          controlBridgeFrame(observer),
          controlBridgeFrame(run.stateForLastCommand()),
        ]),
      );
      expect((await reading).kind).toBe("state");
      const closing = host.close();
      run.output(run.closedForLastCommand());
      await run.naturalFullJoin();
      expect((await closing).kind).toBe("stopped");
    });

    it.each([
      "wrong-request",
      "wrong-execution",
      "duplicate-state",
      "duplicate-bound",
      "observer-before-bound",
      "pid-mismatch",
      "bound-before-spawn",
      "unexpected-terminal",
      "extra-terminal",
    ])("seals Unknown for %s", async (mode) => {
      const run = fixture();
      const host = createWindowsControlBridgeHost(run.options);
      const opening = open(host);
      if (mode !== "bound-before-spawn") run.spawn();
      if (mode === "observer-before-bound")
        run.output({
          v: 1,
          kind: "state",
          requestId: null,
          executionId: syntheticExecutionId,
          state: controlBridgeSnapshot(),
        });
      else if (mode === "pid-mismatch")
        run.output({
          ...run.bound(),
          bridge: { ...run.bound().bridge, pid: 42 },
        });
      else run.output(run.bound());
      let reading: Promise<unknown> | undefined;
      if (
        ![
          "observer-before-bound",
          "pid-mismatch",
          "bound-before-spawn",
        ].includes(mode)
      ) {
        await opening;
        if (mode === "duplicate-bound") run.output(run.bound());
        else if (mode === "unexpected-terminal")
          run.output({
            v: 1,
            kind: "closed",
            requestId: null,
            executionId: syntheticExecutionId,
            outcome: "stopped",
          });
        else if (mode === "extra-terminal") {
          host.close();
          const closed = run.closedForLastCommand();
          run.output(closed);
          run.output(closed);
        } else {
          reading = host.inspect(signal(), () => true);
          const state = run.stateForLastCommand();
          if (mode === "wrong-request") state.requestId = "e".repeat(32);
          if (mode === "wrong-execution") state.executionId = "e".repeat(32);
          run.output(state);
          if (mode === "duplicate-state") run.output(state);
        }
      }
      const closing = host.close();
      await run.naturalFullJoin();
      if (mode === "bound-before-spawn") await expireCleanup();
      expect(await closing).toEqual({
        kind: "unknown",
        cleanup: mode === "bound-before-spawn" ? "unknown" : "closed",
      });
      await opening;
      if (reading) await reading;
      expect(run.killCount).toBe(0);
    });

    it.each(["startup", "request", "session"])(
      "observes the %s deadline without a retry",
      async (mode) => {
        const run = fixture();
        const host = createWindowsControlBridgeHost(run.options);
        const opening = open(host);
        run.spawn();
        let reading: Promise<unknown> | undefined;
        if (mode !== "startup") {
          run.output(run.bound());
          await opening;
        }
        if (mode === "request") reading = host.inspect(signal(), () => true);
        const duration =
          mode === "startup" ? 100 : mode === "request" ? 80 : 1_000;
        await vi.advanceTimersByTimeAsync(duration);
        const closing = host.close();
        await expireCleanup();
        expect(await closing).toEqual({ kind: "unknown", cleanup: "unknown" });
        await opening;
        if (reading) await reading;
        expect(run.killCount).toBe(0);
        expect(spawnMock).toHaveBeenCalledTimes(1);
      },
    );

    it.each(["abort", "stale", "throw", "reentrant-close"])(
      "rejects %s scope before spawn and never reopens",
      async (mode) => {
        const host = createWindowsControlBridgeHost(controlBridgeOptions());
        const controller = new AbortController();
        if (mode === "abort") controller.abort();
        const callback = () => {
          if (mode === "throw") throw new Error("private");
          if (mode === "reentrant-close") host.close();
          return mode !== "stale";
        };
        expect(await host.open(controller.signal, callback)).toEqual({
          kind: "unknown",
          cleanup: "closed",
        });
        expect(await open(host)).toEqual({
          kind: "unknown",
          cleanup: "closed",
        });
        expect(spawnMock).not.toHaveBeenCalled();
      },
    );

    it("checks the original scope again before bound publication", async () => {
      const run = fixture();
      const host = createWindowsControlBridgeHost(run.options);
      let current = true;
      const opening = host.open(signal(), () => current);
      run.spawn();
      current = false;
      run.output(run.bound());
      const closing = host.close();
      await run.naturalFullJoin();
      expect(await opening).toEqual({ kind: "unknown", cleanup: "closed" });
      expect((await closing).kind).toBe("unknown");
      expect(run.input).toHaveLength(0);
    });

    it("does not extend startup admission when its timer callback is delayed", async () => {
      const clock = vi.spyOn(performance, "now").mockReturnValue(1_000);
      const run = fixture();
      const host = createWindowsControlBridgeHost(run.options);
      const opening = open(host);
      run.spawn();
      clock.mockReturnValue(1_101);
      run.output(run.bound());
      const closing = host.close();
      await run.naturalFullJoin();
      expect(await opening).toEqual({ kind: "unknown", cleanup: "closed" });
      expect((await closing).kind).toBe("unknown");
    });

    it.each(["dispatch", "bound", "inspect-dispatch", "inspect-publication"])(
      "rejects when a scope callback crosses the %s deadline",
      async (stage) => {
        const clock = vi.spyOn(performance, "now").mockReturnValue(1_000);
        const run = fixture();
        const host = createWindowsControlBridgeHost(run.options);
        let cross = stage === "dispatch";
        const callback = () => {
          if (cross) clock.mockReturnValue(1_101);
          return true;
        };
        const opening = host.open(signal(), callback);
        if (stage === "dispatch") {
          expect(spawnMock).not.toHaveBeenCalled();
          expect(await opening).toEqual({ kind: "unknown", cleanup: "closed" });
          return;
        }
        run.spawn();
        cross = stage === "bound";
        run.output(run.bound());
        if (stage === "bound") {
          const closing = host.close();
          await run.naturalFullJoin();
          expect(await opening).toEqual({ kind: "unknown", cleanup: "closed" });
          expect((await closing).kind).toBe("unknown");
          return;
        }
        await opening;
        let crossInspect = stage === "inspect-dispatch";
        const reading = host.inspect(signal(), () => {
          if (crossInspect) clock.mockReturnValue(1_081);
          return true;
        });
        if (stage === "inspect-dispatch") expect(run.input).toHaveLength(0);
        else {
          await controlBridgeFlush();
          crossInspect = true;
          run.output(run.stateForLastCommand());
        }
        const closing = host.close();
        await run.naturalFullJoin();
        expect(await reading).toEqual({ kind: "unknown", cleanup: "closed" });
        expect((await closing).kind).toBe("unknown");
      },
    );

    it.each([false, true])(
      "keeps Unknown when the delayed cleanup timer expires across publication (callback=%s)",
      async (crossInCallback) => {
        const clock = vi.spyOn(performance, "now").mockReturnValue(1_000);
        const run = fixture();
        const host = createWindowsControlBridgeHost(run.options);
        let cross = false;
        const opening = host.open(signal(), () => {
          if (cross) clock.mockReturnValue(1_031);
          return true;
        });
        run.spawn();
        run.output(run.bound());
        await opening;
        const closing = host.close();
        run.output(run.closedForLastCommand());
        if (crossInCallback) cross = true;
        else clock.mockReturnValue(1_031);
        await run.naturalFullJoin();
        const unknown = await closing;
        expect(unknown).toEqual({ kind: "unknown", cleanup: "unknown" });
        expect(await host.close()).toBe(unknown);
      },
    );

    it("allows a reentrant close to preempt inspect scope without poisoning close", async () => {
      const run = fixture();
      const host = createWindowsControlBridgeHost(run.options);
      await bound(run, host);
      const reading = host.inspect(signal(), () => {
        host.close();
        return true;
      });
      expect(await reading).toEqual({ kind: "unknown", cleanup: "unknown" });
      expect(run.input).toHaveLength(1);
      expect(run.command().op).toBe("close");
      run.output(run.closedForLastCommand());
      await run.naturalFullJoin();
      expect(await host.close()).toEqual({
        kind: "stopped",
        cleanup: "closed",
      });
    });

    it.each([
      "stderr",
      "partial",
      "read-error",
      "nonzero",
      "signal",
      "one-eof",
      "child-close-mismatch",
      "missing-child-close",
    ])("does not replace lifecycle facts after %s", async (mode) => {
      const run = fixture({
        holdChildClose:
          mode === "child-close-mismatch" || mode === "missing-child-close",
      });
      const host = createWindowsControlBridgeHost(run.options);
      await bound(run, host);
      const closing = host.close();
      if (mode === "stderr") run.stderr(Buffer.from("private"));
      if (mode === "partial") run.bytes(Buffer.from("{"));
      if (mode === "read-error")
        run.streams.stdout.emit("error", new Error("private"));
      if (mode !== "partial") run.output(run.closedForLastCommand());
      run.exit(
        mode === "nonzero" ? 2 : mode === "signal" ? null : 0,
        mode === "signal" ? "SIGTERM" : null,
      );
      run.endStdout();
      if (mode !== "one-eof") run.endStderr();
      await controlBridgeFlush();
      if (mode === "child-close-mismatch") run.child.emit("close", 2, null);
      await expireCleanup();
      const result = await closing;
      expect(result.kind).toBe("unknown");
      expect(JSON.stringify(result)).not.toContain("private");
      expect(run.killCount).toBe(0);
    });

    it("waits for observed write/final callbacks before successful close", async () => {
      const run = fixture({ holdWrites: true, holdFinal: true });
      const host = createWindowsControlBridgeHost(run.options);
      await bound(run, host);
      const waiting = host.whenClosed();
      const closing = host.close();
      expect(closing).toBe(waiting);
      expect(host.whenClosed()).toBe(waiting);
      run.output(run.closedForLastCommand());
      run.exit();
      run.endStdout();
      run.endStderr();
      let resolved = false;
      void closing.then(() => {
        resolved = true;
      });
      await controlBridgeFlush();
      expect(resolved).toBe(false);
      run.settleWrite();
      await controlBridgeFlush();
      expect(resolved).toBe(false);
      expect(host.whenClosed()).toBe(waiting);
      expect(run.input).toHaveLength(1);
      run.settleFinal();
      await controlBridgeFlush();
      expect(await closing).toEqual({ kind: "stopped", cleanup: "closed" });
    });

    it("releases a real failed stdin write only after its callback and the complete original join", async () => {
      const run = fixture({ holdWrites: true });
      const host = createWindowsControlBridgeHost(run.options);
      await bound(run, host);
      const waiting = host.whenClosed();
      const closing = host.close();
      expect(closing).toBe(waiting);
      run.output(run.closedForLastCommand());
      run.settleWrite(new Error("synthetic-private-write-error"));
      await run.naturalFullJoin();
      await expireCleanup();
      expect(run.streams.stdin.writableFinished).toBe(false);
      expect(await closing).toEqual({ kind: "unknown", cleanup: "closed" });
      expect(host.whenClosed()).toBe(waiting);
      expect(run.killCount).toBe(0);
    });

    it("seals a random request-ID collision instead of retrying", async () => {
      const run = fixture();
      const host = createWindowsControlBridgeHost(run.options);
      await bound(run, host);
      randomBytesMock.mockReturnValue(Buffer.alloc(16, 1));
      const reading = host.inspect(signal(), () => true);
      run.output(run.stateForLastCommand());
      await reading;
      const closing = host.close();
      await run.naturalFullJoin();
      expect((await closing).kind).toBe("unknown");
      expect(randomBytesMock).toHaveBeenCalledTimes(2);
      expect(run.input).toHaveLength(1);
    });

    it.each(["throw", "ENOENT", "missing-pid", "missing-stream"])(
      "retains unknown creation after %s",
      async (mode) => {
        const run = fixture();
        if (mode === "throw")
          spawnMock.mockReset().mockImplementation(() => {
            throw new Error("private");
          });
        if (mode === "missing-pid") run.streams.pid = undefined;
        if (mode === "missing-stream")
          Object.assign(run.child, { stdout: null });
        const host = createWindowsControlBridgeHost(run.options);
        const opening = open(host);
        if (mode === "ENOENT")
          run.child.emit(
            "error",
            Object.assign(new Error("private"), { code: "ENOENT" }),
          );
        const closing = host.close();
        await expireCleanup();
        expect(await opening).toEqual({ kind: "unknown", cleanup: "unknown" });
        expect(await closing).toEqual({ kind: "unknown", cleanup: "unknown" });
        expect((await open(host)).kind).toBe("unknown");
        expect(spawnMock).toHaveBeenCalledTimes(1);
        expect(run.killCount).toBe(0);
      },
    );

    it("applies response and cumulative output budgets including LF and keeps draining", async () => {
      const run = fixture();
      const bytes = controlBridgeFrame(run.bound());
      const limits = {
        ...run.options.limits,
        maxResponseFrameBytes: bytes.length,
        maxQueuedOutputBytes: bytes.length,
        maxSessionOutputBytes: bytes.length,
      };
      const host = createWindowsControlBridgeHost(
        controlBridgeOptions({ limits }),
      );
      await bound(run, host);
      run.bytes(Buffer.alloc(bytes.length * 3, 0x61));
      run.bytes(Buffer.alloc(bytes.length * 3, 0x61));
      const closing = host.close();
      await run.naturalFullJoin();
      expect((await closing).kind).toBe("unknown");
      expect(run.streams.stdout.readableLength).toBe(0);
      expect(run.killCount).toBe(0);
    });

    it("rejects a request that exceeds the frame/session budget before write", async () => {
      const run = fixture();
      const limits = {
        ...run.options.limits,
        maxRequestFrameBytes: 1,
        maxSessionInputBytes: 1,
      };
      const host = createWindowsControlBridgeHost(
        controlBridgeOptions({ limits }),
      );
      await bound(run, host);
      const reading = host.inspect(signal(), () => true);
      const closing = host.close();
      await run.naturalFullJoin();
      expect((await reading).kind).toBe("unknown");
      expect((await closing).kind).toBe("unknown");
      expect(run.input).toHaveLength(0);
    });

    it.each([0, 1])(
      "request-frame LF boundary independently of session input (%i byte over)",
      async (over) => {
        const run = fixture();
        const request = controlBridgeFrame({
          v: 1,
          kind: "command",
          requestId: "1".padStart(32, "0"),
          op: "inspect",
          executionId: syntheticExecutionId,
        });
        expect(request[request.length - 1]).toBe(0x0a);
        const limits = {
          ...run.options.limits,
          maxRequestFrameBytes: request.length - over,
        };
        expect(limits.maxSessionInputBytes).toBeGreaterThan(request.length * 2);
        const host = createWindowsControlBridgeHost(
          controlBridgeOptions({ limits }),
        );
        await bound(run, host);
        const reading = host.inspect(signal(), () => true);
        let readingResult;
        if (over === 0) {
          expect(run.input).toHaveLength(1);
          expect(run.input[0]!.length).toBe(limits.maxRequestFrameBytes);
          run.output(run.stateForLastCommand());
          readingResult = await reading;
          expect(readingResult.kind).toBe("state");
        }
        const closing = host.close();
        if (over === 0) run.output(run.closedForLastCommand());
        await run.naturalFullJoin();
        readingResult ??= await reading;
        expect(await closing).toEqual(
          over === 0
            ? { kind: "stopped", cleanup: "closed" }
            : { kind: "unknown", cleanup: "closed" },
        );
        expect(readingResult.kind).toBe(over === 0 ? "state" : "unknown");
        expect(run.input).toHaveLength(over === 0 ? 2 : 0);
        await host.inspect(signal(), () => true);
        await host.close();
        expect(run.input).toHaveLength(over === 0 ? 2 : 0);
        expect(run.killCount).toBe(0);
      },
    );

    it.each([0, 1])(
      "response-frame LF boundary independently of session output (%i byte over)",
      async (over) => {
        const run = fixture();
        const boundBytes = controlBridgeFrame(run.bound());
        const limits = {
          ...run.options.limits,
          maxResponseFrameBytes: boundBytes.length,
        };
        expect(limits.maxQueuedOutputBytes).toBeGreaterThan(
          boundBytes.length + 1,
        );
        expect(limits.maxSessionOutputBytes).toBeGreaterThan(
          boundBytes.length * 3,
        );
        const host = createWindowsControlBridgeHost(
          controlBridgeOptions({ limits }),
        );
        await bound(run, host);
        const reading = host.inspect(signal(), () => true);
        await controlBridgeFlush();
        const bytes = controlBridgePaddedFrame(
          run.stateForLastCommand(),
          limits.maxResponseFrameBytes + over,
        );
        expect(bytes[bytes.length - 1]).toBe(0x0a);
        let resolved = false;
        void reading.then(() => {
          resolved = true;
        });
        run.bytes(bytes.subarray(0, limits.maxResponseFrameBytes - 1));
        await controlBridgeFlush();
        expect(resolved).toBe(false);
        run.bytes(bytes.subarray(limits.maxResponseFrameBytes - 1));
        let readingResult;
        if (over === 0) {
          readingResult = await reading;
          expect(readingResult.kind).toBe("state");
        }
        const closing = host.close();
        if (over === 0) run.output(run.closedForLastCommand());
        else {
          const observer = controlBridgeFrame({
            v: 1,
            kind: "state",
            requestId: null,
            executionId: syntheticExecutionId,
            state: controlBridgeSnapshot(),
          });
          run.bytes(observer);
          run.bytes(observer);
        }
        await run.naturalFullJoin();
        readingResult ??= await reading;
        expect(readingResult.kind).toBe(over === 0 ? "state" : "unknown");
        expect(await closing).toEqual(
          over === 0
            ? { kind: "stopped", cleanup: "closed" }
            : { kind: "unknown", cleanup: "closed" },
        );
        expect(run.input).toHaveLength(over === 0 ? 2 : 1);
        expect(run.streams.stdout.readableLength).toBe(0);
        expect(run.killCount).toBe(0);
      },
    );

    it.each([0, 1])(
      "session-input boundary across individually legal requests (%i byte over)",
      async (over) => {
        const run = fixture();
        const inspectLength = controlBridgeFrame({
          v: 1,
          kind: "command",
          requestId: "1".padStart(32, "0"),
          op: "inspect",
          executionId: syntheticExecutionId,
        }).length;
        const closeLength = controlBridgeFrame({
          v: 1,
          kind: "command",
          requestId: "2".padStart(32, "0"),
          op: "close",
          executionId: syntheticExecutionId,
        }).length;
        const limits = {
          ...run.options.limits,
          maxRequestFrameBytes: inspectLength,
          maxSessionInputBytes: inspectLength + closeLength - over,
        };
        const host = createWindowsControlBridgeHost(
          controlBridgeOptions({ limits }),
        );
        await bound(run, host);
        const reading = host.inspect(signal(), () => true);
        run.output(run.stateForLastCommand());
        const originalResult = await reading;
        expect(originalResult.kind).toBe("state");
        expect(run.input[0]!.length).toBe(inspectLength);
        expect(run.input[0]![inspectLength - 1]).toBe(0x0a);
        const closing = host.close();
        if (over === 0) {
          expect(run.input[1]!.length).toBe(closeLength);
          expect(run.input[1]![closeLength - 1]).toBe(0x0a);
          expect(
            run.input.reduce((total, frame) => total + frame.length, 0),
          ).toBe(limits.maxSessionInputBytes);
          run.output(run.closedForLastCommand());
        } else {
          expect(inspectLength + closeLength).toBe(
            limits.maxSessionInputBytes + 1,
          );
        }
        await run.naturalFullJoin();
        expect(await closing).toEqual(
          over === 0
            ? { kind: "stopped", cleanup: "closed" }
            : { kind: "unknown", cleanup: "closed" },
        );
        expect(await reading).toBe(originalResult);
        expect(originalResult.kind).toBe("state");
        expect(run.input).toHaveLength(over === 0 ? 2 : 1);
        await host.inspect(signal(), () => true);
        await host.close();
        expect(run.input).toHaveLength(over === 0 ? 2 : 1);
        expect(run.killCount).toBe(0);
        expect(spawnMock).toHaveBeenCalledTimes(1);
      },
    );

    it.each([0, 1])(
      "session-output boundary across individually legal frames (%i byte over)",
      async (over) => {
        const run = fixture();
        const boundBytes = controlBridgeFrame(run.bound());
        const observer = controlBridgeFrame({
          v: 1,
          kind: "state",
          requestId: null,
          executionId: syntheticExecutionId,
          state: controlBridgeSnapshot(),
        });
        const terminalLength = controlBridgeFrame({
          v: 1,
          kind: "closed",
          requestId: "1".padStart(32, "0"),
          executionId: syntheticExecutionId,
          outcome: "stopped",
        }).length;
        const limits = {
          ...run.options.limits,
          maxResponseFrameBytes: boundBytes.length,
          maxSessionOutputBytes:
            boundBytes.length + observer.length + terminalLength,
        };
        expect(observer.length).toBeLessThanOrEqual(
          limits.maxResponseFrameBytes,
        );
        expect(terminalLength + 1).toBeLessThanOrEqual(
          limits.maxResponseFrameBytes,
        );
        const host = createWindowsControlBridgeHost(
          controlBridgeOptions({ limits }),
        );
        await bound(run, host);
        run.bytes(observer);
        const closing = host.close();
        const terminal = controlBridgePaddedFrame(
          run.closedForLastCommand(),
          terminalLength + over,
        );
        expect(terminal[terminal.length - 1]).toBe(0x0a);
        // Both variants reach a valid partial frame with the final LF still absent.
        run.bytes(terminal.subarray(0, -1));
        run.bytes(terminal.subarray(-1));
        expect(boundBytes.length + observer.length + terminal.length).toBe(
          limits.maxSessionOutputBytes + over,
        );
        if (over === 1) {
          run.bytes(observer);
          run.bytes(observer);
        }
        await run.naturalFullJoin();
        expect(await closing).toEqual(
          over === 0
            ? { kind: "stopped", cleanup: "closed" }
            : { kind: "unknown", cleanup: "closed" },
        );
        expect(run.input).toHaveLength(1);
        expect(run.streams.stdout.readableLength).toBe(0);
        expect(run.killCount).toBe(0);
      },
    );
  },
);

describe.runIf(process.platform !== "win32")(
  "control-bridge Windows admission",
  () => {
    it("rejects non-Windows without spawn", () => {
      expect(() =>
        createWindowsControlBridgeHost(controlBridgeOptions()),
      ).toThrow();
      expect(spawnMock).not.toHaveBeenCalled();
    });
  },
);
