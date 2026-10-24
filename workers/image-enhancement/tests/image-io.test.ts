import { createHash } from "node:crypto";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { createWorkerConfig } from "../src/config.js";
import { normalizePlan } from "../src/contracts.js";
import {
  inspectImage,
  prepareEngineInput,
  validateAiOutput,
} from "../src/image-io.js";
import { configInput, planInput } from "./fixtures.js";

function digest(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function rgbPng(width = 4, height = 3) {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 34, g: 83, b: 125 },
    },
  })
    .png()
    .toBuffer();
}

async function fixturePlan(
  bytes: Buffer,
  configure?: (input: ReturnType<typeof configInput>) => void,
) {
  const input = configInput();
  configure?.(input);
  return normalizePlan(planInput(digest(bytes)), createWorkerConfig(input));
}

describe("M2-A real image inspection", () => {
  it.each(["png", "jpeg"] as const)(
    "fully decodes real %s bytes and reports actual dimensions/digest",
    async (format) => {
      const bytes = await sharp({
        create: { width: 4, height: 3, channels: 3, background: "#22537d" },
      })
        .toFormat(format)
        .toBuffer();
      const result = await inspectImage(bytes, configInput().budgets.input);
      expect(result).toMatchObject({
        format,
        width: 4,
        height: 3,
        displayWidth: 4,
        displayHeight: 3,
        sha256: digest(bytes),
        byteLength: bytes.length,
        hasAlpha: false,
      });
    },
  );

  it("reports EXIF display orientation separately from encoded dimensions", async () => {
    const bytes = await sharp({
      create: { width: 4, height: 3, channels: 3, background: "#22537d" },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    expect(
      await inspectImage(bytes, configInput().budgets.input),
    ).toMatchObject({
      width: 4,
      height: 3,
      displayWidth: 3,
      displayHeight: 4,
      orientation: 6,
    });
  });

  it.each([
    Buffer.alloc(0),
    Buffer.from("not an image"),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  ])("rejects empty/corrupt image bytes", async (bytes) => {
    await expect(
      inspectImage(bytes, configInput().budgets.input),
    ).rejects.toMatchObject({ status: 422, code: "invalid_image" });
  });

  it("rejects a truncated image even when its dimensions can be read", async () => {
    const bytes = await rgbPng();
    const truncated = bytes.subarray(0, bytes.length - 20);
    await expect(
      inspectImage(truncated, configInput().budgets.input),
    ).rejects.toMatchObject({ status: 422, code: "invalid_image" });
  });

  it("rejects corrupt PNG pixel data that still has readable metadata", async () => {
    const corrupt = Buffer.from(await rgbPng());
    const idat = corrupt.indexOf(Buffer.from("IDAT"));
    expect(idat).toBeGreaterThan(0);
    corrupt[idat + 4] = 0;
    expect(await sharp(corrupt).metadata()).toMatchObject({
      width: 4,
      height: 3,
      format: "png",
    });
    await expect(
      inspectImage(corrupt, configInput().budgets.input),
    ).rejects.toMatchObject({ status: 422, code: "invalid_image" });
  });

  it("rejects a decodable but unsupported image format", async () => {
    const bytes = await sharp({
      create: { width: 4, height: 3, channels: 3, background: "#22537d" },
    })
      .webp()
      .toBuffer();
    await expect(
      inspectImage(bytes, configInput().budgets.input),
    ).rejects.toMatchObject({ status: 415, code: "unsupported_media_type" });
  });

  it("accepts exact input byte/pixel limits and rejects either exceeded budget", async () => {
    const bytes = await rgbPng();
    await expect(
      inspectImage(bytes, { maxBytes: bytes.length, maxPixels: 12 }),
    ).resolves.toMatchObject({ width: 4, height: 3 });
    await expect(
      inspectImage(bytes, { maxBytes: bytes.length - 1, maxPixels: 12 }),
    ).rejects.toMatchObject({ status: 413, code: "budget_exceeded" });
    await expect(
      inspectImage(bytes, { maxBytes: bytes.length, maxPixels: 11 }),
    ).rejects.toMatchObject({ status: 413, code: "budget_exceeded" });
  });

  it("does not mistake compressed byte size for decoded pixel budget", async () => {
    const bytes = await rgbPng(100, 100);
    expect(bytes.length).toBeLessThan(10_000);
    await expect(
      inspectImage(bytes, { maxBytes: 10_000, maxPixels: 9_999 }),
    ).rejects.toMatchObject({ status: 413, code: "budget_exceeded" });
  });
});

describe("M2-A engine input preparation", () => {
  it("preserves native bytes while creating a separate unscaled sRGB PNG input", async () => {
    const bytes = await rgbPng();
    const original = Buffer.from(bytes);
    const plan = await fixturePlan(bytes);
    const result = await prepareEngineInput(bytes, plan);

    expect(bytes.equals(original)).toBe(true);
    expect(result.source.bytes.equals(original)).toBe(true);
    expect(result.source).toMatchObject({
      sha256: digest(original),
      width: 4,
      height: 3,
      format: "png",
    });
    expect(result.engineInput).toMatchObject({
      format: "png",
      width: 4,
      height: 3,
      normalizationProfile: "srgb-upright-v1",
    });
    expect(result.engineInput.sha256).toBe(digest(result.engineInput.bytes));
    expect((await sharp(result.engineInput.bytes).metadata()).space).toBe(
      "srgb",
    );
    expect(result.predictedAiSize).toEqual({
      width: 16,
      height: 12,
      pixels: 192,
    });
  });

  it("normalizes EXIF once into upright engine pixels without rewriting the JPEG source", async () => {
    const bytes = await sharp({
      create: { width: 4, height: 3, channels: 3, background: "#22537d" },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const original = Buffer.from(bytes);
    const input = planInput(digest(bytes));
    input.target = { width: 9, height: 12, format: "png" };
    const plan = normalizePlan(input, createWorkerConfig(configInput()));
    const result = await prepareEngineInput(bytes, plan);
    const expected = await sharp(bytes)
      .rotate()
      .toColourspace("srgb")
      .raw()
      .toBuffer({ resolveWithObject: true });
    const actual = await sharp(result.engineInput.bytes)
      .raw()
      .toBuffer({ resolveWithObject: true });

    expect(result.source.bytes.equals(original)).toBe(true);
    expect(result.source).toMatchObject({
      width: 3,
      height: 4,
      encodedWidth: 4,
      encodedHeight: 3,
      orientation: 6,
    });
    expect(result.engineInput).toMatchObject({
      width: 3,
      height: 4,
      format: "png",
    });
    expect(actual.info.width).toBe(3);
    expect(actual.info.height).toBe(4);
    expect(actual.data.equals(expected.data)).toBe(true);
    expect(
      (await sharp(result.engineInput.bytes).metadata()).orientation,
    ).toBeUndefined();
    expect(result.predictedAiSize).toEqual({
      width: 12,
      height: 16,
      pixels: 192,
    });
  });

  it("rejects a source digest mismatch before preparing an engine input", async () => {
    const bytes = await rgbPng();
    const plan = normalizePlan(
      planInput("f".repeat(64)),
      createWorkerConfig(configInput()),
    );
    await expect(prepareEngineInput(bytes, plan)).rejects.toMatchObject({
      status: 422,
      code: "input_digest_mismatch",
    });
  });

  it("checks the 16-times-pixel intermediate budget before any executor exists", async () => {
    const bytes = await rgbPng();
    const allowed = await fixturePlan(bytes, (input) => {
      input.budgets.ai.maxPixels = 192;
    });
    await expect(prepareEngineInput(bytes, allowed)).resolves.toMatchObject({
      predictedAiSize: { pixels: 192 },
    });
    const refused = await fixturePlan(bytes, (input) => {
      input.budgets.ai.maxPixels = 191;
    });
    await expect(prepareEngineInput(bytes, refused)).rejects.toMatchObject({
      status: 413,
      code: "budget_exceeded",
    });
  });

  it.each(["equal", "below"] as const)(
    "checks real JPEG-to-PNG expansion with AI byte limit %s normalized size",
    async (boundary) => {
      const pixels = Buffer.alloc(64 * 64 * 3);
      for (let offset = 0; offset < pixels.length; offset += 32) {
        createHash("sha256")
          .update(`fixture-jpeg-noise-${offset}`)
          .digest()
          .copy(pixels, offset);
      }
      const bytes = await sharp(pixels, {
        raw: { width: 64, height: 64, channels: 3 },
      })
        .jpeg({ quality: 20 })
        .toBuffer();
      const normalizedPng = await sharp(bytes)
        .rotate()
        .toColourspace("srgb")
        .removeAlpha()
        .png()
        .toBuffer();
      expect(bytes.length).toBeLessThan(normalizedPng.length);
      const config = configInput();
      config.budgets.input.maxBytes = bytes.length + 1;
      config.budgets.ai.maxBytes =
        normalizedPng.length - (boundary === "below" ? 1 : 0);
      const input = planInput(digest(bytes));
      input.target = { width: 128, height: 128, format: "png" };
      const plan = normalizePlan(input, createWorkerConfig(config));
      expect(bytes.length).toBeLessThan(plan.budgets.input.maxBytes);
      if (boundary === "below") {
        await expect(prepareEngineInput(bytes, plan)).rejects.toMatchObject({
          status: 413,
          code: "budget_exceeded",
        });
      } else {
        const result = await prepareEngineInput(bytes, plan);
        expect(result.engineInput.byteLength).toBe(plan.budgets.ai.maxBytes);
        expect(result.engineInput.sha256).toBe(digest(normalizedPng));
        expect(result.source.bytes.equals(bytes)).toBe(true);
      }
    },
  );

  it("rejects a target that requires crop or stretch", async () => {
    const bytes = await rgbPng();
    const input = planInput(digest(bytes));
    input.target = { width: 12, height: 12, format: "png" };
    const plan = normalizePlan(input, createWorkerConfig(configInput()));
    await expect(prepareEngineInput(bytes, plan)).rejects.toMatchObject({
      status: 422,
      code: "aspect_ratio_mismatch",
    });
  });

  it("rejects a target beyond one native 4x pass rather than chain upscale", async () => {
    const bytes = await rgbPng();
    const input = planInput(digest(bytes));
    input.target = { width: 20, height: 15, format: "png" };
    const plan = normalizePlan(input, createWorkerConfig(configInput()));
    await expect(prepareEngineInput(bytes, plan)).rejects.toMatchObject({
      status: 422,
      code: "unsupported_target",
    });
  });

  it("does not silently flatten transparent product input in the first scope", async () => {
    const bytes = await sharp({
      create: {
        width: 4,
        height: 3,
        channels: 4,
        background: { r: 34, g: 83, b: 125, alpha: 0.5 },
      },
    })
      .png()
      .toBuffer();
    const plan = await fixturePlan(bytes);
    await expect(prepareEngineInput(bytes, plan)).rejects.toMatchObject({
      status: 422,
      code: "unsupported_transparency",
    });
  });
});

describe("M2-A AI intermediate output validation", () => {
  it.each([0, 0.5])(
    "rejects 4x PNG output with alpha %s for an opaque full-image input",
    async (alpha) => {
      const native = await rgbPng();
      const plan = await fixturePlan(native);
      const { engineInput } = await prepareEngineInput(native, plan);
      const ai = await sharp({
        create: {
          width: 16,
          height: 12,
          channels: 4,
          background: { r: 34, g: 83, b: 125, alpha },
        },
      })
        .png()
        .toBuffer();
      const original = Buffer.from(ai);
      await expect(
        validateAiOutput(ai, engineInput, plan),
      ).rejects.toMatchObject({ status: 422, code: "invalid_output" });
      expect(ai.equals(original)).toBe(true);
    },
  );

  it("accepts fully opaque RGBA 4x PNG without removing alpha or rewriting bytes", async () => {
    const native = await rgbPng();
    const plan = await fixturePlan(native);
    const { engineInput } = await prepareEngineInput(native, plan);
    const ai = await sharp({
      create: {
        width: 16,
        height: 12,
        channels: 4,
        background: { r: 34, g: 83, b: 125, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const original = Buffer.from(ai);
    expect((await sharp(ai).metadata()).hasAlpha).toBe(true);
    const result = await validateAiOutput(ai, engineInput, plan);
    expect(result.bytes.equals(original)).toBe(true);
    expect(result.sha256).toBe(digest(original));
    expect((await sharp(result.bytes).metadata()).hasAlpha).toBe(true);
  });

  it("accepts only fully decoded native 4x PNG and reports its actual immutable identity", async () => {
    const native = await rgbPng();
    const plan = await fixturePlan(native);
    const { engineInput } = await prepareEngineInput(native, plan);
    const ai = await rgbPng(16, 12);
    const original = Buffer.from(ai);
    const result = await validateAiOutput(ai, engineInput, plan, digest(ai));

    expect(result).toMatchObject({
      format: "png",
      width: 16,
      height: 12,
      sha256: digest(ai),
      byteLength: ai.length,
    });
    expect(result.bytes.equals(original)).toBe(true);
    expect(ai.equals(original)).toBe(true);
    expect(result.width).not.toBe(plan.target.width);
    expect(result.height).not.toBe(plan.target.height);
  });

  it.each([
    [12, 9],
    [16, 13],
    [12, 16],
  ])(
    "rejects AI output %sx%s that is not source-display 4x",
    async (width, height) => {
      const native = await rgbPng();
      const plan = await fixturePlan(native);
      const { engineInput } = await prepareEngineInput(native, plan);
      await expect(
        validateAiOutput(await rgbPng(width, height), engineInput, plan),
      ).rejects.toMatchObject({ status: 422, code: "invalid_output" });
    },
  );

  it("rejects JPEG bytes even if an output filename would say PNG", async () => {
    const native = await rgbPng();
    const plan = await fixturePlan(native);
    const { engineInput } = await prepareEngineInput(native, plan);
    const jpeg = await sharp({
      create: { width: 16, height: 12, channels: 3, background: "#22537d" },
    })
      .jpeg()
      .toBuffer();
    await expect(
      validateAiOutput(jpeg, engineInput, plan),
    ).rejects.toMatchObject({ status: 422, code: "invalid_output" });
  });

  it("rejects missing/corrupt output bytes without trusting a successful process exit", async () => {
    const native = await rgbPng();
    const plan = await fixturePlan(native);
    const { engineInput } = await prepareEngineInput(native, plan);
    for (const bytes of [
      Buffer.alloc(0),
      Buffer.from("fixture process said Done"),
      (await rgbPng(16, 12)).subarray(0, 45),
    ]) {
      await expect(
        validateAiOutput(bytes, engineInput, plan),
      ).rejects.toMatchObject({ status: 422, code: "invalid_output" });
    }
  });

  it("checks AI output bytes independently with an inclusive limit", async () => {
    const native = await rgbPng();
    const ai = await rgbPng(16, 12);
    const boundary = await fixturePlan(native, (input) => {
      input.budgets.ai.maxBytes = ai.length;
    });
    const { engineInput } = await prepareEngineInput(native, boundary);
    await expect(
      validateAiOutput(ai, engineInput, boundary),
    ).resolves.toMatchObject({ byteLength: ai.length });
    const refused = await fixturePlan(native, (input) => {
      input.budgets.ai.maxBytes = ai.length - 1;
    });
    await expect(
      validateAiOutput(ai, engineInput, refused),
    ).rejects.toMatchObject({ status: 413, code: "budget_exceeded" });
  });

  it("rejects a supplied AI digest mismatch and does not rewrite the artifact", async () => {
    const native = await rgbPng();
    const plan = await fixturePlan(native);
    const { engineInput } = await prepareEngineInput(native, plan);
    const ai = await rgbPng(16, 12);
    const original = Buffer.from(ai);
    await expect(
      validateAiOutput(ai, engineInput, plan, "f".repeat(64)),
    ).rejects.toMatchObject({ status: 422, code: "output_digest_mismatch" });
    expect(ai.equals(original)).toBe(true);
  });
});
