import { validateImageLayerBytes } from "../image-processing/output-validation";

export type ValidatedImageLayerOutput = { dataUrl: string; width: number; height: number; bytes: number; mimeType: string; kind: "element" | "background" };

export async function validateImageLayerOutputs(sourceDataUrl: string, outputDataUrls: string[]): Promise<ValidatedImageLayerOutput[]> {
    if (!outputDataUrls.length) throw new Error("上游没有返回分层图片");
    async function* outputs() {
        for (const value of outputDataUrls) yield inlineBytes(value, "分层结果");
    }
    const validated = await validateImageLayerBytes(inlineBytes(sourceDataUrl, "源图"), outputs());
    return validated.map((output, index) => ({ ...output, dataUrl: outputDataUrls[index] }));
}

function inlineBytes(value: string, label: string) {
    const match = value.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/i);
    if (!match) throw new Error(`${label}无法读取`);
    return Buffer.from(match[2], "base64");
}
