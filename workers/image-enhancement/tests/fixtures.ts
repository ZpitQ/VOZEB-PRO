export function configInput() {
  return {
    protocolVersion: "image-enhancement.v1",
    normalizationProfile: "srgb-upright-v1",
    models: [
      {
        id: "standard-4x",
        binaryVersion: "fixture-binary-v1",
        binarySha256: "b".repeat(64),
        modelVersion: "fixture-model-v1",
        modelSha256: "c".repeat(64),
        nativeScale: 4,
        allowedTiles: [0, 128, 256],
        defaultTile: 256,
        tta: false,
        gpuId: 0,
      },
    ],
    budgets: {
      input: { maxBytes: 20 * 1024 * 1024, maxPixels: 40_000_000 },
      ai: { maxBytes: 160 * 1024 * 1024, maxPixels: 40_000_000 },
      delivery: { maxBytes: 96 * 1024 * 1024, maxPixels: 20_000_000 },
    },
  };
}

export function planInput(sourceSha256 = "a".repeat(64)) {
  return {
    protocolVersion: "image-enhancement.v1",
    scope: "full_image",
    sourceSha256,
    target: { width: 12, height: 9, format: "png" },
    modelId: "standard-4x",
    normalizationProfile: "srgb-upright-v1",
    tile: 256,
  };
}
