import { describe, expect, it } from "vitest";

import { createHttpTransportLimits } from "../src/http-config.js";
import { transportLimits } from "./http-fixtures.js";

const legacyLimits = {
  maxPlanBytes: transportLimits.maxPlanBytes,
  maxMultipartOverheadBytes: transportLimits.maxMultipartOverheadBytes,
  maxConcurrentUploads: transportLimits.maxConcurrentUploads,
  maxReceiptBytes: transportLimits.maxReceiptBytes,
  maxConcurrentReceipts: transportLimits.maxConcurrentReceipts,
  headersTimeoutMs: transportLimits.headersTimeoutMs,
  requestTimeoutMs: transportLimits.requestTimeoutMs,
  maxHeaderBytes: transportLimits.maxHeaderBytes,
};

describe("explicit HTTP download capacity", () => {
  it("preserves all nine explicit limits in a frozen copy with independent download capacity", () => {
    const input = { ...legacyLimits, maxConcurrentDownloads: 3 };
    const limits = createHttpTransportLimits(input);

    expect(input.maxConcurrentDownloads).not.toBe(input.maxConcurrentUploads);
    expect(limits).toEqual(input);
    expect(limits).not.toBe(input);
    expect(Object.isFrozen(limits)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
  });

  it("rejects configuration without download capacity instead of borrowing upload capacity", () => {
    expect(() => createHttpTransportLimits(legacyLimits)).toThrowError(
      expect.objectContaining({ code: "configuration_invalid" }),
    );
  });

  it.each([
    0,
    -1,
    1.5,
    Number.POSITIVE_INFINITY,
    Number.NaN,
    Number.MAX_SAFE_INTEGER + 1,
    "3",
    undefined,
  ])("rejects an unsafe or nonnumeric download capacity %#", (value) => {
    expect(() =>
      createHttpTransportLimits({
        ...legacyLimits,
        maxConcurrentDownloads: value,
      }),
    ).toThrowError(expect.objectContaining({ code: "configuration_invalid" }));
  });

  it.each([
    { extra: true },
    { headersTimeoutMs: transportLimits.requestTimeoutMs + 1 },
    { requestTimeoutMs: 2 ** 31 },
  ])("preserves existing exact-key and deadline constraints %#", (override) => {
    expect(() =>
      createHttpTransportLimits({
        ...legacyLimits,
        maxConcurrentDownloads: 3,
        ...override,
      }),
    ).toThrowError(expect.objectContaining({ code: "configuration_invalid" }));
  });
});
