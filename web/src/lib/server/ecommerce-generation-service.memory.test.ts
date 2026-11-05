import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildWhiteBackgroundProductProtection } from "./ecommerce-generation-service";
import type { EcommerceVisualAnalysis } from "./ecommerce-visual-analysis";

const cases = [
    { id: "F01", width: 64, height: 48, left: 22, top: 10, productWidth: 20, productHeight: 28, lastX: 41, lastY: 37, outsideX: 21, outsideRightX: 42, alphaSum: 142800 },
    { id: "F02", width: 7997, height: 5334, left: 2400, top: 1200, productWidth: 3200, productHeight: 2800, lastX: 5599, lastY: 3999, outsideX: 2399, outsideRightX: 5600, alphaSum: 2284800000 },
    { id: "F10", width: 8000, height: 8000, left: 2400, top: 2600, productWidth: 3200, productHeight: 2800, lastX: 5599, lastY: 5399, outsideX: 2399, outsideRightX: 5600, alphaSum: 2284800000 },
];

describe("original-size product protection memory regression", () => {
    let directory: string;

    beforeAll(async () => {
        directory = await mkdtemp(join(tmpdir(), "vozeb-product-protection-"));
        await prepareFixture(directory, cases[0]);
        await prepareFixture(directory, cases[1]);
        await prepareFixture(directory, cases[2]);
    }, 120000);

    afterAll(async () => {
        await rm(directory, { recursive: true, force: true });
    });

    it.each(cases)(
        "reads, protects, encodes and saves the original $id product",
        async (fixture) => {
            const sourcePath = join(directory, fixture.id + ".png");
            const source = await readFile(sourcePath);
            const sourceHash = createHash("sha256").update(source).digest("hex");
            const input = productAnalysis();
            const analysisBefore = structuredClone(input);

            const regions = await buildWhiteBackgroundProductProtection(source, input, "product");
            expect(regions.sourceSize).toEqual({ width: fixture.width, height: fixture.height });
            expect(regions.productCore.rectangles).toEqual([{ x: fixture.left, y: fixture.top, width: fixture.productWidth, height: fixture.productHeight }]);
            expect(regions.editableBackground.mask).toMatchObject({ trust: "trusted", provider: "white-background-flood-fill.v1", reference: { id: "product-background-mask", type: "image/png", width: fixture.width, height: fixture.height } });
            const mask = regions.editableBackground.mask!.reference;
            const bytes = Buffer.from(mask.dataUrl!.split(",")[1], "base64");
            const outputPath = join(directory, fixture.id + "-mask.png");
            await writeFile(outputPath, bytes);

            const persisted = await readFile(outputPath);
            expect(persisted.equals(bytes)).toBe(true);
            expect(await sharp(persisted).metadata()).toMatchObject({ width: fixture.width, height: fixture.height, channels: 4, format: "png" });
            expect(await maskAlpha(persisted, fixture.left, fixture.top)).toBe(255);
            expect(await maskAlpha(persisted, fixture.lastX, fixture.lastY)).toBe(255);
            expect(await maskAlpha(persisted, fixture.outsideX, fixture.top)).toBe(0);
            expect(await maskAlpha(persisted, fixture.outsideRightX, fixture.lastY)).toBe(0);
            const alphaBytes = await sharp(persisted).extractChannel("alpha").png().toBuffer();
            const alpha = await sharp(alphaBytes).stats();
            expect(alpha.channels[0]).toMatchObject({ min: 0, max: 255, sum: fixture.alphaSum });
            expect(createHash("sha256").update(source).digest("hex")).toBe(sourceHash);
            expect(
                createHash("sha256")
                    .update(await readFile(sourcePath))
                    .digest("hex"),
            ).toBe(sourceHash);
            expect(input).toEqual(analysisBefore);
        },
        120000,
    );
});

async function prepareFixture(directory: string, fixture: (typeof cases)[number]) {
    const source = await sharp({ create: { width: fixture.width, height: fixture.height, channels: 4, background: "#ffffff" } })
        .composite([{ input: { create: { width: fixture.productWidth, height: fixture.productHeight, channels: 4, background: "#252525" } }, left: fixture.left, top: fixture.top }])
        .png()
        .toBuffer();
    await writeFile(join(directory, fixture.id + ".png"), source);
}

async function maskAlpha(bytes: Buffer, left: number, top: number) {
    const pixel = await sharp(bytes).extract({ left, top, width: 1, height: 1 }).ensureAlpha().raw().toBuffer();
    return pixel[3];
}

function productAnalysis(): EcommerceVisualAnalysis {
    return {
        analysisVersion: "ecommerce-visual-analysis.v1",
        modelRole: { logicalRole: "vision_analysis", logicalModelId: "vision-role", channelId: "vision-channel", upstreamModel: "vision-upstream" },
        references: [
            {
                assetId: "product",
                role: "product",
                confidence: "high",
                visualEvidence: { whiteBackground: true, transparentBackground: false, isolatedSubject: true, completeScene: false },
                productFacts: { identity: "chair", outline: "chair outline", color: "oak", material: "wood", brandText: [], view: "front" },
                sceneFacts: null,
                productCore: { x: 0.3, y: 0.2, width: 0.4, height: 0.6 },
                fusionHalo: { x: 0.25, y: 0.15, width: 0.5, height: 0.7 },
                editableTargets: [],
            },
        ],
    };
}
