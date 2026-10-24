import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSystemClock } from "../src/clock.js";
import { EnhancementError } from "../src/contracts.js";

const epoch = 1_800_000_000_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(epoch);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function expectInvalid(operation: () => unknown) {
  let observed: unknown;
  try {
    operation();
  } catch (error) {
    observed = error;
  }
  expect(observed).toBeInstanceOf(EnhancementError);
  const expected = new EnhancementError("configuration_invalid");
  expect(observed).toMatchObject({
    code: expected.code,
    status: expected.status,
    message: expected.message,
  });
}

describe("system clock", () => {
  it("returns a frozen clock and reads the current epoch on every call", () => {
    const clock = createSystemClock();
    expect(Object.isFrozen(clock)).toBe(true);
    expect(clock.now()).toBe(epoch);
    vi.setSystemTime(epoch + 123);
    expect(clock.now()).toBe(epoch + 123);
    vi.setSystemTime(epoch - 321);
    expect(clock.now()).toBe(epoch - 321);
    vi.setSystemTime(0);
    expect(clock.now()).toBe(0);
  });

  it("waits for a future absolute target and notifies exactly once", () => {
    const clock = createSystemClock();
    const callback = vi.fn();
    clock.scheduleAt(epoch + 200, callback);

    expect(callback).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(199);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1_000);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it.each([epoch, epoch - 20, 0])(
    "notifies asynchronously once for an already reached target %s",
    (at) => {
      const clock = createSystemClock();
      const callback = vi.fn();
      clock.scheduleAt(at, callback);

      expect(callback).not.toHaveBeenCalled();
      vi.runOnlyPendingTimers();
      expect(callback).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(1_000);
      expect(callback).toHaveBeenCalledTimes(1);
    },
  );

  it("cancels idempotently and leaves no pending timer", () => {
    const clock = createSystemClock();
    const callback = vi.fn();
    const cancel = clock.scheduleAt(epoch + 200, callback);

    cancel();
    cancel();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1_000);
    expect(callback).not.toHaveBeenCalled();
  });

  it("ignores an old timer callback that was already queued before cancellation", () => {
    const clock = createSystemClock();
    const scheduled = vi.spyOn(globalThis, "setTimeout");
    const callback = vi.fn();
    const cancel = clock.scheduleAt(epoch + 200, callback);
    const queued = scheduled.mock.calls[0]?.[0];
    expect(queued).toBeTypeOf("function");
    if (typeof queued !== "function") throw new Error("Missing timer callback");

    cancel();
    cancel();
    vi.setSystemTime(epoch + 200);
    expect(() => queued()).not.toThrow();
    expect(callback).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends the schedule before calling user code, including reentrant delivery", () => {
    const clock = createSystemClock();
    const scheduled = vi.spyOn(globalThis, "setTimeout");
    let replay = () => {};
    const callback = vi.fn((): void => {
      if (callback.mock.calls.length === 1) replay();
    });
    clock.scheduleAt(epoch + 200, callback);
    const queued = scheduled.mock.calls[0]?.[0];
    expect(queued).toBeTypeOf("function");
    if (typeof queued !== "function") throw new Error("Missing timer callback");
    replay = () => queued();

    vi.advanceTimersByTime(200);
    expect(callback).toHaveBeenCalledTimes(1);
    replay();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps independent schedules when one is cancelled", () => {
    const clock = createSystemClock();
    const first = vi.fn();
    const second = vi.fn();
    const cancelFirst = clock.scheduleAt(epoch + 100, first);
    clock.scheduleAt(epoch + 200, second);

    cancelFirst();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(199);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("splits a long wait at the platform limit without overflow or a busy loop", () => {
    const clock = createSystemClock();
    const scheduled = vi.spyOn(globalThis, "setTimeout");
    const warnings = vi.spyOn(process, "emitWarning");
    const callback = vi.fn();
    const platformLimit = 2 ** 31 - 1;
    clock.scheduleAt(epoch + platformLimit + 200, callback);

    // Check the public timer boundary before advancing a potentially huge wait.
    expect(scheduled.mock.calls[0]?.[1]).toBe(platformLimit);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersToNextTimer();
    expect(Date.now()).toBe(epoch + platformLimit);
    expect(callback).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(199);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(
      scheduled.mock.calls.every(
        ([, delay]) =>
          typeof delay === "number" && delay >= 0 && delay <= platformLimit,
      ),
    ).toBe(true);
    expect(warnings).not.toHaveBeenCalled();
  });

  it("rechecks the same absolute target after the wall clock moves backwards", () => {
    const clock = createSystemClock();
    const callback = vi.fn();
    clock.scheduleAt(epoch + 100, callback);
    vi.advanceTimersByTime(90);
    vi.setSystemTime(epoch - 1_000);

    vi.advanceTimersByTime(10);
    expect(callback).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1_089);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(Date.now()).toBe(epoch + 100);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("notifies once at the next timer wake after the wall clock moves forwards", () => {
    const clock = createSystemClock();
    const callback = vi.fn();
    clock.scheduleAt(epoch + 100, callback);
    vi.advanceTimersByTime(90);
    vi.setSystemTime(epoch + 500);

    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1_000);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("accepts a maximum safe integer target without overflowing a timer", () => {
    const clock = createSystemClock();
    const callback = vi.fn();
    const cancel = clock.scheduleAt(Number.MAX_SAFE_INTEGER, callback);

    expect(callback).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid absolute target %s without retaining a timer", (at) => {
    const clock = createSystemClock();
    const callback = vi.fn();
    expectInvalid(() => clock.scheduleAt(at, callback));
    expect(callback).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])(
    "rejects invalid live epoch %s from both reads and new schedules",
    (value) => {
      const clock = createSystemClock();
      const callback = vi.fn();
      vi.spyOn(Date, "now").mockReturnValue(value);

      expectInvalid(() => clock.now());
      expectInvalid(() => clock.scheduleAt(epoch + 100, callback));
      expect(callback).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("rejects an invalid live epoch on timer wake without delivering or retaining work", () => {
    const clock = createSystemClock();
    const callback = vi.fn();
    const cancel = clock.scheduleAt(epoch + 100, callback);
    vi.spyOn(Date, "now").mockReturnValue(Number.NaN);

    expectInvalid(() => vi.advanceTimersByTime(100));
    expect(callback).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => cancel()).not.toThrow();
  });
});
