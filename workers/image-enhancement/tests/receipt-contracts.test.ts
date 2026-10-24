import { describe, expect, it } from "vitest";

import { parseReceiptRequest } from "../src/contracts.js";

function request() {
  return {
    serviceId: "f187c72a-4d9a-4f41-9763-09db13e36ddc",
    receiptId: "a9c16e4d-06ab-4cc2-87c8-c2f012be1d36",
    result: {
      format: "png" as const,
      width: 16,
      height: 12,
      sha256: "ab".repeat(32),
      byteLength: 127,
    },
  };
}

describe("strict result receipt input", () => {
  it("copies and freezes a complete receipt while canonicalizing UUID and SHA case", () => {
    const source = request();
    const input = {
      result: { ...source.result, sha256: source.result.sha256.toUpperCase() },
      receiptId: source.receiptId.toUpperCase(),
      serviceId: source.serviceId.toUpperCase(),
    };
    const parsed = parseReceiptRequest(input);
    expect(parsed).toEqual(source);
    expect(parsed).not.toBe(input);
    expect(parsed.result).not.toBe(input.result);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.result)).toBe(true);
    input.result.width = 99;
    input.receiptId = request().serviceId;
    expect(parsed).toEqual(source);
  });

  it("rejects non-plain objects and missing or extra fields at either level", () => {
    const source = request();
    const { receiptId: _receiptId, ...missingReceipt } = source;
    const { sha256: _sha256, ...missingDigest } = source.result;
    const withSymbol = { ...source, [Symbol("extra")]: true };
    const values: unknown[] = [
      undefined,
      null,
      [],
      "{}",
      Object.assign(Object.create(null), source),
      Object.assign(Object.create({ inherited: true }), source),
      missingReceipt,
      { ...source, clientId: "self-claimed-client" },
      withSymbol,
      { ...source, result: null },
      { ...source, result: [] },
      { ...source, result: Object.assign(Object.create(null), source.result) },
      { ...source, result: missingDigest },
      { ...source, result: { ...source.result, bytes: "not-allowed" } },
    ];
    for (const value of values) {
      expect(() => parseReceiptRequest(value)).toThrowError(
        expect.objectContaining({ code: "invalid_request", status: 400 }),
      );
    }
  });

  it("requires bounded UUID text for both service and receipt identities", () => {
    for (const field of ["serviceId", "receiptId"] as const) {
      for (const value of [
        "",
        "not-a-uuid",
        request()[field].replaceAll("-", ""),
        ` ${request()[field]}`,
        `${request()[field]}\n`,
        `${request()[field]}0`,
        request()[field].replace("-", "g"),
        123,
        null,
      ]) {
        expect(() =>
          parseReceiptRequest({ ...request(), [field]: value }),
        ).toThrowError(
          expect.objectContaining({ code: "invalid_request", status: 400 }),
        );
      }
    }
  });

  it("requires safe positive numbers without coercion for all result sizes", () => {
    for (const field of ["width", "height", "byteLength"] as const) {
      for (const value of [
        0,
        -0,
        -1,
        1.5,
        Number.MAX_SAFE_INTEGER + 1,
        NaN,
        Infinity,
        "12",
        null,
        undefined,
      ]) {
        const source = request();
        expect(() =>
          parseReceiptRequest({
            ...source,
            result: { ...source.result, [field]: value },
          }),
        ).toThrowError(
          expect.objectContaining({ code: "invalid_request", status: 400 }),
        );
      }
    }
  });

  it("accepts only PNG and exactly sixty-four hexadecimal digest characters", () => {
    const source = request();
    const values: unknown[] = [
      { ...source, result: { ...source.result, format: "jpeg" } },
      { ...source, result: { ...source.result, format: "PNG" } },
      ...[
        "",
        "a".repeat(63),
        "a".repeat(65),
        "g".repeat(64),
        ` ${source.result.sha256}`,
        `${source.result.sha256}\n`,
        null,
        123,
      ].map((sha256) => ({
        ...source,
        result: { ...source.result, sha256 },
      })),
    ];
    for (const value of values) {
      expect(() => parseReceiptRequest(value)).toThrowError(
        expect.objectContaining({ code: "invalid_request", status: 400 }),
      );
    }
  });
});
