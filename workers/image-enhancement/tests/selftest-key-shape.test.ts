import { describe, expect, it } from "vitest";

import * as Contracts from "../src/contracts.js";

const canonical = "vozeb:self-test:v1:a50e3af5-8e82-4bad-8c0b-a1ae6f5b3629";

function accepts(value: unknown): unknown {
  const helper: unknown = Reflect.get(Contracts, "isInternalSelfTestKey");
  expect(typeof helper, "contracts exposes isInternalSelfTestKey").toBe(
    "function",
  );
  return Reflect.apply(helper as (...args: unknown[]) => unknown, undefined, [
    value,
  ]);
}

describe("internal self-test key complete shape", () => {
  it("accepts the canonical lowercase UUID v4 key", () => {
    expect(accepts(canonical) === true).toBe(true);
  });

  it.each([
    ["LF", "\n"],
    ["CR", "\r"],
    ["CRLF", "\r\n"],
    ["U+2028", "\u2028"],
    ["U+2029", "\u2029"],
  ] as const)(
    "rejects a trailing %s instead of accepting a partial UUID match",
    (_label, ending) => {
      expect(accepts(canonical + ending) === false).toBe(true);
    },
  );

  const nonStrings: readonly (readonly [string, unknown])[] = [
    ["undefined", undefined],
    ["null", null],
    ["boolean", false],
    ["number", 0],
    ["bigint", 0n],
    ["symbol", Symbol("fixture-key-shape")],
    ["boxed string", new String(canonical)],
    ["array", [canonical]],
    ["record", { key: canonical }],
    ["function", () => canonical],
  ];
  it.each(nonStrings)(
    "rejects unknown non-string input: %s",
    (_label, value) => {
      expect(accepts(value) === false).toBe(true);
    },
  );
});
