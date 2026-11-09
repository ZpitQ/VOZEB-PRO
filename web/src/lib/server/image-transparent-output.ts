import { assertTransparentImageBytes } from "../image-processing/output-validation";

export async function assertTransparentImageOutput(dataUrl: string) {
    const match = dataUrl.match(/^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=]+)$/i);
    if (!match) throw new Error("透明图片结果无法读取");
    await assertTransparentImageBytes(Buffer.from(match[1], "base64"));
}
