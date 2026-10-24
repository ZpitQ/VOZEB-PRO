import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createWorkerConfig } from "../src/config.js";
import {
  EnhancementError,
  normalizePlan,
  parsePlanRequest,
  requestFingerprint,
  parsePlanJson,
  toErrorResponse,
} from "../src/contracts.js";
import { configInput, planInput } from "./fixtures.js";

describe("M2-A frozen enhancement plan", () => {
  it("accepts the exact expected strategy without changing frozen plan identity", () => {
    const config = createWorkerConfig(configInput());
    const input = planInput();
    const frozen = normalizePlan(input, config);
    expect(normalizePlan({ ...input, expectedStrategyFingerprint: frozen.strategyFingerprint.toUpperCase() }, config)).toEqual(frozen);
  });
  it.each(["model", "budget"])("rejects a changed %s before accepting the frozen strategy", (field) => {
    const input = planInput();
    const baseline = normalizePlan(input, createWorkerConfig(configInput()));
    const changed = configInput();
    if (field === "model") changed.models[0]!.modelSha256 = "e".repeat(64);
    else changed.budgets.ai.maxPixels -= 1;
    expect(() => normalizePlan({ ...input, expectedStrategyFingerprint: baseline.strategyFingerprint }, createWorkerConfig(changed))).toThrowError(expect.objectContaining({ code: "strategy_mismatch", status: 409 }));
  });
  it.each([null, "", "not-a-digest", 123])("rejects malformed expected strategy %s", (expectedStrategyFingerprint) => {
    expect(() => normalizePlan({ ...planInput(), expectedStrategyFingerprint }, createWorkerConfig(configInput()))).toThrowError(expect.objectContaining({ code: "invalid_plan", status: 422 }));
  });
  it("binds replay identity to the caller's expected strategy", () => {
    const first = parsePlanRequest({ ...planInput(), expectedStrategyFingerprint: "a".repeat(64) });
    const second = parsePlanRequest({ ...planInput(), expectedStrategyFingerprint: "b".repeat(64) });
    expect(requestFingerprint(first, 256)).not.toBe(requestFingerprint(second, 256));
  });
  it("freezes only allowed strategy values and independent source identity", () => {
    const config = createWorkerConfig(configInput());
    const input = planInput();
    const plan = normalizePlan(input, config);

    expect(plan).toMatchObject({
      protocolVersion: "image-enhancement.v1",
      scope: "full_image",
      sourceSha256: "a".repeat(64),
      target: { width: 12, height: 9, format: "png" },
      normalizationProfile: "srgb-upright-v1",
      engine: {
        modelId: "standard-4x",
        binaryVersion: "fixture-binary-v1",
        binarySha256: "b".repeat(64),
        modelVersion: "fixture-model-v1",
        modelSha256: "c".repeat(64),
        nativeScale: 4,
        tile: 256,
        tta: false,
        gpuId: 0,
      },
      budgets: configInput().budgets,
    });
    expect(plan.strategyFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.planFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.target)).toBe(true);
    expect(Object.isFrozen(plan.engine)).toBe(true);
    expect(Object.isFrozen(plan.budgets.ai)).toBe(true);
    input.target.width = 99;
    expect(plan.target.width).toBe(12);
  });

  it("canonicalizes SHA-256 case and JSON key order without changing identity", () => {
    const config = createWorkerConfig(configInput());
    const original = planInput("AB".repeat(32));
    const reordered = {
      tile: original.tile,
      target: { format: "png", height: 9, width: 12 },
      sourceSha256: "ab".repeat(32),
      scope: original.scope,
      protocolVersion: original.protocolVersion,
      normalizationProfile: original.normalizationProfile,
      modelId: original.modelId,
    };

    const first = normalizePlan(original, config);
    const second = normalizePlan(reordered, config);
    expect(first.sourceSha256).toBe("ab".repeat(32));
    expect(first.planFingerprint).toBe(second.planFingerprint);
    expect(first.strategyFingerprint).toBe(second.strategyFingerprint);
  });

  it("keeps input identity separate from strategy identity", () => {
    const config = createWorkerConfig(configInput());
    const first = normalizePlan(planInput("a".repeat(64)), config);
    const second = normalizePlan(planInput("d".repeat(64)), config);
    expect(second.strategyFingerprint).toBe(first.strategyFingerprint);
    expect(second.planFingerprint).not.toBe(first.planFingerprint);
  });

  it.each([
    [
      "target",
      (input: ReturnType<typeof planInput>) => {
        input.target.width = 16;
      },
    ],
    [
      "tile",
      (input: ReturnType<typeof planInput>) => {
        input.tile = 128;
      },
    ],
  ])("changes strategy identity when %s changes", (_label, mutate) => {
    const config = createWorkerConfig(configInput());
    const original = normalizePlan(planInput(), config);
    const input = planInput();
    mutate(input);
    const changed = normalizePlan(input, config);
    expect(changed.strategyFingerprint).not.toBe(original.strategyFingerprint);
    expect(changed.planFingerprint).not.toBe(original.planFingerprint);
  });

  it("includes trusted model, binary and budget snapshots in strategy identity", () => {
    const baseline = normalizePlan(
      planInput(),
      createWorkerConfig(configInput()),
    );
    for (const field of ["binarySha256", "modelSha256"] as const) {
      const changed = configInput();
      changed.models[0]![field] = "e".repeat(64);
      const plan = normalizePlan(planInput(), createWorkerConfig(changed));
      expect(plan.strategyFingerprint).not.toBe(baseline.strategyFingerprint);
    }
    const changed = configInput();
    changed.budgets.ai.maxPixels -= 1;
    expect(
      normalizePlan(planInput(), createWorkerConfig(changed))
        .strategyFingerprint,
    ).not.toBe(baseline.strategyFingerprint);
  });

  it("uses only the configured model default when tile is omitted", () => {
    const input: Record<string, unknown> = planInput();
    delete input.tile;
    expect(
      normalizePlan(input, createWorkerConfig(configInput())).engine.tile,
    ).toBe(256);
  });

  it.each([
    ["executable", "arbitrary-command"],
    ["modelPath", "../other-model"],
    ["workDir", "outside-task"],
    ["url", "https://example.invalid/input.png"],
    ["prompt", "ignored shell text"],
    ["strategyFingerprint", "f".repeat(64)],
    ["protected", false],
  ])("rejects unknown request field %s", (key, value) => {
    expect(() =>
      normalizePlan(
        { ...planInput(), [key]: value },
        createWorkerConfig(configInput()),
      ),
    ).toThrowError(
      expect.objectContaining({ status: 400, code: "invalid_request" }),
    );
  });

  it("rejects unknown nested fields rather than passing them to a command", () => {
    const input = planInput();
    expect(() =>
      normalizePlan(
        { ...input, target: { ...input.target, crop: true } },
        createWorkerConfig(configInput()),
      ),
    ).toThrowError(
      expect.objectContaining({ status: 400, code: "invalid_request" }),
    );
  });

  it.each([
    ["protocolVersion", "image-enhancement.v2"],
    ["scope", "product_to_scene"],
    ["scope", "masked_edit"],
    ["normalizationProfile", "unversioned"],
    ["modelId", "not-in-allowlist"],
    ["modelId", "../standard-4x"],
    ["sourceSha256", "abc"],
    ["sourceSha256", ` ${"a".repeat(64)}`],
    ["tile", 64],
    ["tile", "256"],
    ["tile", -1],
  ])("rejects invalid %s strategy values", (key, value) => {
    expect(() =>
      normalizePlan(
        { ...planInput(), [key]: value },
        createWorkerConfig(configInput()),
      ),
    ).toThrowError(
      expect.objectContaining({ status: 422, code: "invalid_plan" }),
    );
  });

  it.each([0, -1, 1.5, "12", Number.MAX_SAFE_INTEGER + 1])(
    "rejects non-positive/inexact target dimension %s",
    (width) => {
      const input = planInput();
      expect(() =>
        normalizePlan(
          { ...input, target: { ...input.target, width } },
          createWorkerConfig(configInput()),
        ),
      ).toThrowError(
        expect.objectContaining({ status: 422, code: "invalid_plan" }),
      );
    },
  );

  it("rejects missing fields with a malformed-request error", () => {
    const input: Record<string, unknown> = planInput();
    delete input.sourceSha256;
    expect(() =>
      normalizePlan(input, createWorkerConfig(configInput())),
    ).toThrowError(
      expect.objectContaining({ status: 400, code: "invalid_request" }),
    );
  });

  it.each([null, [], "text", 1])("rejects a non-object plan", (input) => {
    expect(() =>
      normalizePlan(input, createWorkerConfig(configInput())),
    ).toThrowError(
      expect.objectContaining({ status: 400, code: "invalid_request" }),
    );
  });

  it("rejects prototype-bearing and prototype-key plan values", () => {
    const config = createWorkerConfig(configInput());
    expect(() =>
      normalizePlan(
        Object.assign(Object.create({ executable: "hidden" }), planInput()),
        config,
      ),
    ).toThrowError(
      expect.objectContaining({ status: 400, code: "invalid_request" }),
    );
    expect(() =>
      normalizePlan(
        JSON.parse(`{"__proto__":{},${JSON.stringify(planInput()).slice(1)}`),
        config,
      ),
    ).toThrowError(
      expect.objectContaining({ status: 400, code: "invalid_request" }),
    );
  });

  it("enforces delivery pixel budget with an inclusive maximum", () => {
    const input = planInput();
    const boundary = configInput();
    boundary.budgets.delivery.maxPixels = 108;
    expect(normalizePlan(input, createWorkerConfig(boundary)).target).toEqual(
      input.target,
    );
    boundary.budgets.delivery.maxPixels = 107;
    expect(() =>
      normalizePlan(input, createWorkerConfig(boundary)),
    ).toThrowError(
      expect.objectContaining({ status: 413, code: "budget_exceeded" }),
    );
  });

  it("parses only valid JSON and produces no raw payload in errors", () => {
    expect(parsePlanJson(JSON.stringify(planInput()))).toEqual(planInput());
    try {
      parsePlanJson('{"private":"fixture-private-value"');
      expect.fail("malformed JSON must be rejected");
    } catch (error) {
      expect(error).toMatchObject({ status: 400, code: "invalid_request" });
      expect(String(error)).not.toContain("fixture-private-value");
    }
  });

  it("keeps caller-owned bytes outside the strategy fingerprint input", () => {
    const sourceSha256 = createHash("sha256")
      .update("source fixture")
      .digest("hex");
    const plan = normalizePlan(
      planInput(sourceSha256),
      createWorkerConfig(configInput()),
    );
    expect(plan.sourceSha256).toBe(sourceSha256);
    expect(JSON.stringify(plan)).not.toContain("source fixture");
  });
});

describe("M2-A controlled worker configuration", () => {
  it.each([1, 31])(
    "rejects fixed NCNN tile %s below the nonzero minimum",
    (tile) => {
      const input = configInput();
      input.models[0]!.allowedTiles = [tile];
      input.models[0]!.defaultTile = tile;
      expect(() => createWorkerConfig(input)).toThrowError(
        expect.objectContaining({ status: 503, code: "configuration_invalid" }),
      );
    },
  );

  it.each([0, 32])(
    "accepts NCNN tile %s only when controlled by the model whitelist",
    (tile) => {
      const input = configInput();
      input.models[0]!.allowedTiles = [tile];
      input.models[0]!.defaultTile = tile;
      const config = createWorkerConfig(input);
      expect(normalizePlan({ ...planInput(), tile }, config).engine.tile).toBe(
        tile,
      );
      expect(() =>
        normalizePlan({ ...planInput(), tile: tile === 0 ? 32 : 0 }, config),
      ).toThrowError(
        expect.objectContaining({ status: 422, code: "invalid_plan" }),
      );
    },
  );

  it("clones and deeply freezes the trusted model whitelist and budgets", () => {
    const input = configInput();
    const config = createWorkerConfig(input);
    expect(Object.isFrozen(config.models)).toBe(true);
    expect(Object.isFrozen(config.models[0]!.allowedTiles)).toBe(true);
    expect(Object.isFrozen(config.budgets.input)).toBe(true);
    input.models[0]!.allowedTiles.push(64);
    input.budgets.input.maxPixels = 1;
    expect(config.models[0]!.allowedTiles).toEqual([0, 128, 256]);
    expect(config.budgets.input.maxPixels).toBe(40_000_000);
  });

  it.each([
    [
      "duplicate model",
      (input: ReturnType<typeof configInput>) => {
        input.models.push({ ...input.models[0]! });
      },
    ],
    [
      "unsupported scale",
      (input: ReturnType<typeof configInput>) => {
        input.models[0]!.nativeScale = 2;
      },
    ],
    [
      "model path",
      (input: ReturnType<typeof configInput>) => {
        input.models[0]!.id = "../model";
      },
    ],
    [
      "unlisted default tile",
      (input: ReturnType<typeof configInput>) => {
        input.models[0]!.defaultTile = 64;
      },
    ],
    [
      "invalid hash",
      (input: ReturnType<typeof configInput>) => {
        input.models[0]!.modelSha256 = "invalid";
      },
    ],
    [
      "zero budget",
      (input: ReturnType<typeof configInput>) => {
        input.budgets.ai.maxBytes = 0;
      },
    ],
  ])("rejects %s configuration before readiness", (_label, mutate) => {
    const input = configInput();
    mutate(input);
    expect(() => createWorkerConfig(input)).toThrowError(
      expect.objectContaining({ status: 503, code: "configuration_invalid" }),
    );
  });
});

describe("M2-A TC1 error boundary", () => {
  it.each([
    ["authentication_failed", 401],
    ["invalid_request", 400],
    ["unsupported_media_type", 415],
    ["invalid_image", 422],
    ["invalid_plan", 422],
    ["budget_exceeded", 413],
    ["idempotency_conflict", 409],
    ["queue_full", 429],
    ["not_ready", 503],
    ["job_not_found", 404],
    ["result_not_ready", 409],
    ["result_gone", 410],
    ["receipt_conflict", 409],
  ] as const)("maps %s to HTTP %s with a request id", (code, status) => {
    const response = toErrorResponse(
      new EnhancementError(code),
      "request-fixture-01",
    );
    expect(response.status).toBe(status);
    expect(response.body).toMatchObject({
      code,
      data: { requestId: "request-fixture-01" },
    });
    expect(response.body.msg).toEqual(expect.any(String));
  });

  it("does not expose an unknown failure message, paths or credential-shaped data", () => {
    const response = toErrorResponse(
      new Error("fixture-private-value /private/test-path"),
      "request-fixture-02",
    );
    expect(response).toMatchObject({
      status: 503,
      body: { code: "internal_error" },
    });
    expect(JSON.stringify(response)).not.toContain("fixture-private-value");
    expect(JSON.stringify(response)).not.toContain("test-path");
  });
});
