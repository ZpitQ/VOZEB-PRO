"use client";
import type { ImageEnhancementSettings, ImageEnhancementUpdate, ImageEnhancementCheckRequest, PublicImageEnhancement } from "@/lib/image-enhancement-contract";

export function getImageEnhancement(id: string) {
    return taskRequest(id);
}
export function controlImageEnhancement(id: string, action: "retry" | "cancel") {
    return taskRequest(id, action);
}
async function taskRequest(id: string, action?: "retry" | "cancel"): Promise<PublicImageEnhancement> {
    let response: Response;
    let payload: { code: number; data: PublicImageEnhancement; msg?: unknown } | null;
    try {
        response = await fetch(`/api/image-enhancements/${encodeURIComponent(id)}`, { method: action ? "POST" : "GET", cache: "no-store", credentials: "same-origin", ...(action ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) } : {}) });
        payload = await response.json();
    } catch {
        throw new Error("增强任务操作失败");
    }
    if (!response.ok || payload?.code !== 0) throw new Error(typeof payload?.msg === "string" && payload.msg ? payload.msg : "增强任务操作失败");
    return payload.data;
}

export function getImageEnhancementSettings() {
    return request();
}
export function saveImageEnhancementSettings(input: ImageEnhancementUpdate) {
    return request("PATCH", input);
}
export function checkImageEnhancementSettings(input: ImageEnhancementCheckRequest) {
    return request("POST", input);
}
async function request(method = "GET", body?: unknown): Promise<ImageEnhancementSettings> {
    const response = await fetch("/api/admin/image-enhancement", { method, cache: "no-store", credentials: "same-origin", ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    const payload = (await response.json()) as { code: number; data: ImageEnhancementSettings; msg?: string };
    if (!response.ok || payload.code !== 0) throw new Error(payload.msg || "增强配置操作失败");
    return payload.data;
}
