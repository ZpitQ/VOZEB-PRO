import { describe, expect, it } from "vitest";

import { createHttpTransportLimits } from "../src/http-config.js";

const input = {
  maxPlanBytes: 16 * 1024,
  maxMultipartOverheadBytes: 64 * 1024,
  maxConcurrentUploads: 2,
  maxConcurrentDownloads: 3,
  maxReceiptBytes: 1024,
  maxConcurrentReceipts: 4,
  headersTimeoutMs: 10_000,
  requestTimeoutMs: 30_000,
  maxHeaderBytes: 16 * 1024,
};

describe("explicit HTTP receipt limits", () => {
  it("freezes exactly nine explicit limits without sharing caller state or capacity", () => {
    const limits = createHttpTransportLimits(input);
    expect(limits).toEqual(input);
    expect(limits).not.toBe(input);
    expect(Object.keys(limits)).toHaveLength(9);
    expect(Object.isFrozen(limits)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
    expect(limits.maxConcurrentReceipts).not.toBe(limits.maxConcurrentUploads);
    expect(limits.maxConcurrentReceipts).not.toBe(
      limits.maxConcurrentDownloads,
    );
    expect(limits.maxReceiptBytes).not.toBe(limits.maxPlanBytes);
  });

  it.each(["maxReceiptBytes", "maxConcurrentReceipts"] as const)(
    "requires an explicit safe positive integer for %s without defaults",
    (key) => {
      const missing = Object.fromEntries(
        Object.entries(input).filter(([name]) => name !== key),
      );
      expect(() => createHttpTransportLimits(missing)).toThrowError(
        expect.objectContaining({ code: "configuration_invalid" }),
      );
      for (const value of [
        0,
        -1,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
        "1",
        null,
        undefined,
      ])
        expect(() =>
          createHttpTransportLimits({ ...input, [key]: value }),
        ).toThrowError(
          expect.objectContaining({ code: "configuration_invalid" }),
        );
    },
  );

  it.each([
    { extra: true },
    { headersTimeoutMs: input.requestTimeoutMs + 1 },
    { requestTimeoutMs: 2 ** 31 },
  ])("preserves exact-key and shared deadline constraints %#", (override) => {
    expect(() =>
      createHttpTransportLimits({ ...input, ...override }),
    ).toThrowError(expect.objectContaining({ code: "configuration_invalid" }));
  });
});
