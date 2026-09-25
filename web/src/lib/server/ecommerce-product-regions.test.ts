import { describe, expect, it } from "vitest";

import type { EcommerceVisualAnalysis } from "./ecommerce-visual-analysis";
import { buildProductProtectionRegions, compileStrictProductEdit, validateProductProtectionRegions, type ProductProtectionRegions } from "./ecommerce-product-regions";

describe("ecommerce product protection regions", () => {
    it("builds a complete non-overlapping core, halo, and editable background partition", () => {
        const regions = buildProductProtectionRegions(visualAnalysis(), { width: 1000, height: 800 });

        expect(regions.productCore.rectangles).toEqual([{ x: 300, y: 160, width: 400, height: 480 }]);
        expect(regions.fusionHalo.rectangles.length).toBeGreaterThan(0);
        expect(regions.editableBackground.rectangles.length).toBeGreaterThan(0);
        expect(() => validateProductProtectionRegions(regions, { width: 1000, height: 800 })).not.toThrow();
        expect(maskPixels(regions.productCore) + maskPixels(regions.fusionHalo) + maskPixels(regions.editableBackground)).toBe(800_000);
    });

    it("rejects an empty product core", () => {
        const regions = buildProductProtectionRegions(visualAnalysis(), { width: 1000, height: 800 });

        expect(() => validateProductProtectionRegions({ ...regions, productCore: { ...regions.productCore, rectangles: [] } }, regions.sourceSize)).toThrow(/商品核心区不能为空/);
    });

    it("rejects a detached fusion halo", () => {
        const regions = buildProductProtectionRegions(visualAnalysis(), { width: 1000, height: 800 });

        expect(() => validateProductProtectionRegions({ ...regions, fusionHalo: { ...regions.fusionHalo, rectangles: [{ x: 0, y: 0, width: 20, height: 20 }] } }, regions.sourceSize)).toThrow(/融合光晕区必须与商品核心区相邻/);
    });

    it("rejects a fusion halo that expands beyond the bounded allowance", () => {
        const regions = buildProductProtectionRegions(visualAnalysis(), { width: 1000, height: 800 });

        expect(() =>
            validateProductProtectionRegions(
                {
                    ...regions,
                    fusionHalo: {
                        ...regions.fusionHalo,
                        rectangles: [
                            { x: 0, y: 0, width: 1000, height: 160 },
                            { x: 0, y: 160, width: 300, height: 480 },
                            { x: 700, y: 160, width: 300, height: 480 },
                            { x: 0, y: 640, width: 1000, height: 160 },
                        ],
                    },
                },
                regions.sourceSize,
            ),
        ).toThrow(/融合光晕区范围过大/);
    });

    it("rejects editable background overlap with product core", () => {
        const regions = buildProductProtectionRegions(visualAnalysis(), { width: 1000, height: 800 });

        expect(() =>
            validateProductProtectionRegions(
                {
                    ...regions,
                    editableBackground: {
                        ...regions.editableBackground,
                        rectangles: [{ x: 350, y: 200, width: 100, height: 100 }],
                    },
                },
                regions.sourceSize,
            ),
        ).toThrow(/可编辑背景不得覆盖商品核心区/);
    });

    it("rejects masks whose dimensions do not match the source", () => {
        const regions = trustedRegions();

        expect(() => validateProductProtectionRegions({ ...regions, editableBackground: { ...regions.editableBackground, width: 999 } }, regions.sourceSize)).toThrow(/蒙版尺寸必须与源图一致/);
    });

    it("compiles a trusted OpenAI edit into an independent mask request", () => {
        const result = compileStrictProductEdit(openAiTask(), trustedRegions());

        expect(result.state).toBe("ready");
        if (result.state !== "ready") throw new Error(result.reason);
        expect(result.task.mask).toMatchObject({ name: "editable-background.png", width: 1000, height: 800 });
        expect(result.task.prompt).toContain("商品核心像素");
        expect(result.task.productProtection).toMatchObject({
            compilerVersion: "strict-product.v1",
            state: "ready",
            productAnchorId: "product-asset",
        });
    });

    it("requires a trustworthy mask instead of silently generating the whole image", () => {
        const result = compileStrictProductEdit(openAiTask(), buildProductProtectionRegions(visualAnalysis(), { width: 1000, height: 800 }));

        expect(result).toMatchObject({ state: "needs_review", reason: expect.stringMatching(/可信商品蒙版/) });
        expect(result.task.mask).toBeUndefined();
        expect(result.task.productProtection).toMatchObject({ state: "needs_review" });
    });

    it("routes strict-product Gemini edits to review because prompt-only masks are not trustworthy", () => {
        const source = openAiTask();
        const result = compileStrictProductEdit({ ...source, config: { ...source.config, apiFormat: "gemini" as const } }, trustedRegions());

        expect(result).toMatchObject({ state: "needs_review", reason: expect.stringMatching(/不支持可信独立蒙版/) });
    });
});

function visualAnalysis(): EcommerceVisualAnalysis {
    return {
        analysisVersion: "ecommerce-visual-analysis.v1",
        modelRole: { logicalRole: "vision_analysis", logicalModelId: "vision-model", channelId: "vision-channel", upstreamModel: "vision-upstream" },
        references: [
            {
                assetId: "product-asset",
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

function trustedRegions(): ProductProtectionRegions {
    const regions = buildProductProtectionRegions(visualAnalysis(), { width: 1000, height: 800 });
    return {
        ...regions,
        editableBackground: {
            ...regions.editableBackground,
            mask: {
                trust: "trusted",
                provider: "subject-segmentation",
                reference: { id: "background-mask", name: "editable-background.png", type: "image/png", dataUrl: "data:image/png;base64,AA==", width: 1000, height: 800 },
            },
        },
    };
}

function openAiTask() {
    return {
        kind: "edit" as const,
        prompt: "put the product in a bright living room",
        config: { baseUrl: "https://images.example/v1", apiKey: "secret", apiFormat: "openai" as const, model: "gpt-image" },
        references: [{ id: "product-asset", dataUrl: "data:image/png;base64,AA==", width: 1000, height: 800 }],
    };
}

function maskPixels(mask: { rectangles: Array<{ width: number; height: number }> }) {
    return mask.rectangles.reduce((total, region) => total + region.width * region.height, 0);
}
