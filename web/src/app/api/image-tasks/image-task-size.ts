import { parseImageDimensions } from "@/lib/image-size";
import { ecommerceCanvasSize, validateEcommerceDimensions, type EcommerceCanvasProviderRequest } from "@/lib/server/ecommerce-edit-plan";
import { updateImageTask, type ImageTask } from "@/lib/server/image-task-store";

import { parseImageRatio, resolveEcommerceCanvasRequestSize } from "@/lib/image-generation-size";
export { resolveRequestSize, resolveResultSize, imageRequestAspectRatio, resolveSize, parseImageRatio, parseImageDimensions, validateImageSize } from "@/lib/image-generation-size";

export class EcommerceCanvasAdapterReview extends Error {
    constructor(adapter: string) {
        super(`当前 ${adapter} 图片适配器尚不支持画布约束，需复核后选择已验证的适配器`);
    }
}

export function resolveCanvasRequestSize(task: ImageTask, quality: string | undefined): string | undefined {
    return resolveEcommerceCanvasRequestSize(task.ecommerceExecution?.canvas, quality, task.config.size || "auto");
}

export function canvasProviderDimensions(request: EcommerceCanvasProviderRequest | undefined) {
    if (!request) return undefined;
    return parseImageDimensions(request.size || "") || (request.width && request.height ? { width: request.width, height: request.height } : undefined);
}

export async function recordEcommerceCanvasRequest(task: ImageTask, request: EcommerceCanvasProviderRequest, adapter: string) {
    const canvas = task.ecommerceExecution?.canvas;
    if (!canvas) return;
    const dimensions = canvasProviderDimensions(request);
    const ratio = request.aspectRatio || (request.size?.includes(":") ? request.size : undefined);
    const geometries = [dimensions, ratio ? parseImageRatio(ratio) : undefined].filter((size) => size !== undefined);
    if (!geometries.length || (canvas.mode === "exact" && !dimensions)) throw new EcommerceCanvasAdapterReview(adapter);
    for (const size of geometries) {
        validateEcommerceDimensions(size);
        if (BigInt(size.width) * BigInt(canvas.size.height) !== BigInt(size.height) * BigInt(canvas.size.width)) throw new EcommerceCanvasAdapterReview(adapter);
    }
    if (canvas.mode === "exact" && (dimensions!.width !== canvas.size.width || dimensions!.height !== canvas.size.height)) throw new EcommerceCanvasAdapterReview(adapter);
    await updateImageTask(task.id, { ecommerceCanvasRequest: request });
    task.ecommerceCanvasRequest = request;
}

export function templateCanvasRequest(template: string, payload: unknown): EcommerceCanvasProviderRequest {
    const request: EcommerceCanvasProviderRequest = {};
    const collect = (source: unknown, rendered: unknown) => {
        if (typeof source === "string") {
            const key = source.match(/^\{\{\s*(size|ratio|aspect_ratio|width|height)\s*\}\}$/)?.[1];
            if (key && (typeof rendered === "string" || typeof rendered === "number")) {
                if (key === "width" || key === "height") request[key] = Number(rendered);
                else if (key === "size") request.size = String(rendered);
                else request.aspectRatio = String(rendered);
            }
        } else if (source && typeof source === "object" && rendered && typeof rendered === "object") {
            for (const [key, value] of Object.entries(source)) collect(value, (rendered as Record<string, unknown>)[key]);
        }
    };
    collect(JSON.parse(template), payload);
    return request;
}
