import { createHash } from "node:crypto";

import sharp from "sharp";

import type { ResourceLimits } from "./config.js";
import {
  EnhancementError,
  type FrozenEnhancementPlan,
  NORMALIZATION_PROFILE,
} from "./contracts.js";

export type ImageInfo = Readonly<{
  format: "png" | "jpeg";
  width: number;
  height: number;
  displayWidth: number;
  displayHeight: number;
  orientation: number;
  sha256: string;
  byteLength: number;
  hasAlpha: boolean;
}>;

export type EngineInput = Readonly<{
  bytes: Buffer;
  format: "png";
  width: number;
  height: number;
  sha256: string;
  byteLength: number;
  normalizationProfile: typeof NORMALIZATION_PROFILE;
}>;

export type PreparedEngineInput = Readonly<{
  source: Readonly<{
    bytes: Buffer;
    format: "png" | "jpeg";
    width: number;
    height: number;
    encodedWidth: number;
    encodedHeight: number;
    orientation: number;
    sha256: string;
    byteLength: number;
  }>;
  engineInput: EngineInput;
  predictedAiSize: Readonly<{ width: number; height: number; pixels: number }>;
}>;

export type ValidatedAiArtifact = Readonly<{
  bytes: Buffer;
  format: "png";
  width: number;
  height: number;
  sha256: string;
  byteLength: number;
}>;

function digest(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function checkPixels(width: number, height: number, maxPixels: number) {
  if (BigInt(width) * BigInt(height) > BigInt(maxPixels))
    throw new EnhancementError("budget_exceeded");
}

async function decodeImage(
  bytes: Buffer,
  limits: ResourceLimits,
): Promise<{ info: ImageInfo; isOpaque: boolean }> {
  if (bytes.length > limits.maxBytes)
    throw new EnhancementError("budget_exceeded");
  try {
    const metadata = await sharp(bytes, {
      failOn: "warning",
      limitInputPixels: false,
    }).metadata();
    if (metadata.format !== "png" && metadata.format !== "jpeg")
      throw new EnhancementError("unsupported_media_type");
    const { width, height } = metadata;
    if (
      !width ||
      !height ||
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      (metadata.pages ?? 1) !== 1
    ) {
      throw new EnhancementError("invalid_image");
    }
    checkPixels(width, height, limits.maxPixels);
    const stats = await sharp(bytes, {
      failOn: "warning",
      limitInputPixels: limits.maxPixels,
    }).stats();
    const orientation = metadata.orientation ?? 1;
    const swap = orientation >= 5 && orientation <= 8;
    const info: ImageInfo = Object.freeze({
      format: metadata.format,
      width,
      height,
      displayWidth: swap ? height : width,
      displayHeight: swap ? width : height,
      orientation,
      sha256: digest(bytes),
      byteLength: bytes.length,
      hasAlpha: metadata.hasAlpha ?? false,
    });
    return { info, isOpaque: stats.isOpaque };
  } catch (error) {
    if (error instanceof EnhancementError) throw error;
    throw new EnhancementError("invalid_image");
  }
}

export async function inspectImage(
  bytes: Buffer,
  limits: ResourceLimits,
): Promise<ImageInfo> {
  return (await decodeImage(bytes, limits)).info;
}

export async function prepareEngineInput(
  nativeBytes: Buffer,
  plan: FrozenEnhancementPlan,
): Promise<PreparedEngineInput> {
  const { info: native, isOpaque } = await decodeImage(
    nativeBytes,
    plan.budgets.input,
  );
  if (native.sha256 !== plan.sourceSha256)
    throw new EnhancementError("input_digest_mismatch");
  const predictedWidth = native.displayWidth * plan.engine.nativeScale;
  const predictedHeight = native.displayHeight * plan.engine.nativeScale;
  checkPixels(predictedWidth, predictedHeight, plan.budgets.ai.maxPixels);
  if (
    BigInt(plan.target.width) * BigInt(native.displayHeight) !==
    BigInt(plan.target.height) * BigInt(native.displayWidth)
  ) {
    throw new EnhancementError("aspect_ratio_mismatch");
  }
  if (
    plan.target.width > predictedWidth ||
    plan.target.height > predictedHeight
  )
    throw new EnhancementError("unsupported_target");
  try {
    if (!isOpaque) {
      throw new EnhancementError("unsupported_transparency");
    }
    const normalized = await sharp(nativeBytes, {
      failOn: "warning",
      limitInputPixels: plan.budgets.input.maxPixels,
    })
      .rotate()
      .toColourspace("srgb")
      .removeAlpha()
      .png()
      .toBuffer();
    const normalizedInfo = await inspectImage(normalized, {
      maxBytes: plan.budgets.ai.maxBytes,
      maxPixels: plan.budgets.input.maxPixels,
    });
    return Object.freeze({
      source: Object.freeze({
        bytes: Buffer.from(nativeBytes),
        format: native.format,
        width: native.displayWidth,
        height: native.displayHeight,
        encodedWidth: native.width,
        encodedHeight: native.height,
        orientation: native.orientation,
        sha256: native.sha256,
        byteLength: native.byteLength,
      }),
      engineInput: Object.freeze({
        bytes: normalized,
        format: "png" as const,
        width: normalizedInfo.width,
        height: normalizedInfo.height,
        sha256: normalizedInfo.sha256,
        byteLength: normalizedInfo.byteLength,
        normalizationProfile: NORMALIZATION_PROFILE,
      }),
      predictedAiSize: Object.freeze({
        width: predictedWidth,
        height: predictedHeight,
        pixels: predictedWidth * predictedHeight,
      }),
    });
  } catch (error) {
    if (error instanceof EnhancementError) throw error;
    throw new EnhancementError("invalid_image");
  }
}

export async function validateAiOutput(
  bytes: Buffer,
  engineInput: EngineInput,
  plan: FrozenEnhancementPlan,
  expectedSha256?: string,
): Promise<ValidatedAiArtifact> {
  try {
    const { info: output, isOpaque } = await decodeImage(
      bytes,
      plan.budgets.ai,
    );
    if (
      output.format !== "png" ||
      output.orientation !== 1 ||
      !isOpaque ||
      output.width !== engineInput.width * plan.engine.nativeScale ||
      output.height !== engineInput.height * plan.engine.nativeScale
    )
      throw new EnhancementError("invalid_output");
    if (
      expectedSha256 !== undefined &&
      output.sha256 !== expectedSha256.toLowerCase()
    )
      throw new EnhancementError("output_digest_mismatch");
    return Object.freeze({
      bytes: Buffer.from(bytes),
      format: "png" as const,
      width: output.width,
      height: output.height,
      sha256: output.sha256,
      byteLength: output.byteLength,
    });
  } catch (error) {
    if (error instanceof EnhancementError) {
      if (
        error.code === "invalid_image" ||
        error.code === "unsupported_media_type"
      )
        throw new EnhancementError("invalid_output");
      throw error;
    }
    throw new EnhancementError("invalid_output");
  }
}
