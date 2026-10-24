"use client";

import { RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { CreativeAsset } from "@/lib/creative-runtime-contract";
import { ENHANCEMENT_REASONS, type PublicImageEnhancement } from "@/lib/image-enhancement-contract";
import { cn } from "@/lib/utils";
import { IMAGE_TASK_POLL_INTERVAL_MS } from "@/services/api/image";
import { controlImageEnhancement, getImageEnhancement } from "@/services/api/image-enhancement";

export function CreativeImageEnhancement({
    original,
    enhanced,
    activeAssetId,
    onSelect,
    onEnhancementComplete,
}: {
    original: CreativeAsset;
    enhanced?: CreativeAsset;
    activeAssetId: string;
    onSelect: (id: string) => void;
    onEnhancementComplete?: (conversationId: string) => Promise<void>;
}) {
    const skipLabel = imageEnhancementSkipLabel(original.metadata.enhancementSkip);
    const enhancementId = !skipLabel && typeof original.metadata.enhancementId === "string" ? original.metadata.enhancementId.trim() : "";
    const [task, setTask] = useState<PublicImageEnhancement>();
    const [check, setCheck] = useState(0);
    const [reading, setReading] = useState(false);
    const [readError, setReadError] = useState(false);
    const [operationError, setOperationError] = useState(false);
    const [pending, setPending] = useState<"retry" | "cancel">();
    const [refreshingAssets, setRefreshingAssets] = useState(false);
    const [refreshError, setRefreshError] = useState(false);
    const alive = useRef(false);
    const request = useRef(0);
    const controlling = useRef(false);

    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
            request.current += 1;
        };
    }, []);

    useEffect(() => {
        if (!enhancementId) return;
        const current = ++request.current;
        let active = true;
        setReading(true);
        void getImageEnhancement(enhancementId)
            .then((next) => {
                if (!active || current !== request.current) return;
                setTask(next);
                setReadError(false);
                setOperationError(false);
            })
            .catch(() => {
                if (active && current === request.current) setReadError(true);
            })
            .finally(() => {
                if (active && current === request.current) setReading(false);
            });
        return () => {
            active = false;
        };
    }, [check, enhancementId]);

    useEffect(() => {
        if (reading || readError || operationError || pending || (task?.status !== "queued" && task?.status !== "running")) return;
        const timer = window.setTimeout(() => setCheck((current) => current + 1), IMAGE_TASK_POLL_INTERVAL_MS);
        return () => window.clearTimeout(timer);
    }, [task, reading, readError, operationError, pending]);

    useEffect(() => {
        if (task?.status !== "succeeded" || enhanced || !onEnhancementComplete) {
            setRefreshingAssets(false);
            return;
        }
        let active = true;
        setRefreshingAssets(true);
        setRefreshError(false);
        void onEnhancementComplete(original.conversationId)
            .catch(() => {
                if (active) setRefreshError(true);
            })
            .finally(() => {
                if (active) setRefreshingAssets(false);
            });
        return () => {
            active = false;
        };
    }, [task, enhanced, onEnhancementComplete, original.conversationId]);

    const control = async (action: "retry" | "cancel") => {
        if (controlling.current || !enhancementId || (action === "retry" ? !task?.canRetry : !task?.canCancel)) return;
        controlling.current = true;
        const current = ++request.current;
        setReading(false);
        setPending(action);
        setOperationError(false);
        try {
            const next = await controlImageEnhancement(enhancementId, action);
            if (!alive.current || current !== request.current) return;
            setTask(next);
            setReadError(false);
        } catch {
            if (alive.current && current === request.current) setOperationError(true);
        } finally {
            if (alive.current && current === request.current) {
                controlling.current = false;
                setPending(undefined);
            }
        }
    };

    if (!enhancementId && !skipLabel && !enhanced) return null;
    const activeAsset = activeAssetId === original.id ? original : enhanced?.id === activeAssetId ? enhanced : undefined;
    const currentDimensions =
        activeAsset && Number.isInteger(activeAsset.width) && Number(activeAsset.width) > 0 && Number.isInteger(activeAsset.height) && Number(activeAsset.height) > 0
            ? `${activeAsset.id === original.id ? "当前原图" : "当前AI增强"} ${activeAsset.width}×${activeAsset.height}`
            : undefined;
    const status = readError
        ? "暂时无法读取增强状态，原图仍可用"
        : operationError
          ? "增强操作未完成，请检查增强状态，原图仍可用"
          : refreshError
            ? "增强图片暂时不可用，原图仍可用"
            : skipLabel || imageEnhancementStatus(task, Boolean(enhanced), refreshingAssets);
    const buttonClass =
        "inline-flex h-7 items-center justify-center gap-1 rounded-md border border-[#e4e7ec] bg-white px-2 text-[11px] font-medium text-[#667085] transition hover:border-[#cfd4dc] hover:bg-[#f8f9fb] hover:text-[#344054] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-45 dark:border-[#343a43] dark:bg-[#181b20] dark:text-[#aab2bc] dark:hover:border-[#4a525c] dark:hover:bg-[#22262c] dark:hover:text-white";
    return (
        <div className="mt-2 min-w-0 space-y-1.5" aria-label="图像增强与版本">
            <div className="flex flex-wrap items-center gap-1.5" aria-label="图像版本">
                <button type="button" className={cn(buttonClass, activeAssetId === original.id && "!border-primary !text-primary")} aria-pressed={activeAssetId === original.id} onClick={() => onSelect(original.id)}>
                    原图
                </button>
                <button type="button" className={cn(buttonClass, enhanced?.id === activeAssetId && "!border-primary !text-primary")} disabled={!enhanced} aria-pressed={enhanced?.id === activeAssetId} onClick={() => enhanced && onSelect(enhanced.id)}>
                    AI增强
                </button>
                {task?.canRetry ? (
                    <button type="button" className={buttonClass} disabled={Boolean(pending) || reading} aria-busy={pending === "retry"} onClick={() => void control("retry")}>
                        <RotateCw className={cn("size-3", pending === "retry" && "animate-spin")} />
                        {task.status === "skipped" ? "补做AI增强" : "重试增强"}
                    </button>
                ) : null}
                {task?.canCancel ? (
                    <button type="button" className={buttonClass} disabled={Boolean(pending) || reading} aria-busy={pending === "cancel"} onClick={() => void control("cancel")}>
                        取消增强
                    </button>
                ) : null}
                {enhancementId && (readError || operationError || (task?.status === "succeeded" && !enhanced)) ? (
                    <button type="button" className={buttonClass} disabled={reading || Boolean(pending) || refreshingAssets} onClick={() => setCheck((current) => current + 1)}>
                        检查增强状态
                    </button>
                ) : null}
            </div>
            <p role="status" className="break-words text-[11px] leading-5 text-[#667085] dark:text-[#a4adb8]">
                {status}
                {currentDimensions ? ` · ${currentDimensions}` : null}
            </p>
        </div>
    );
}

function imageEnhancementStatus(task: PublicImageEnhancement | undefined, hasEnhanced: boolean, refreshing: boolean) {
    if (!task) return hasEnhanced ? "AI增强已完成" : "正在读取增强状态，原图可用";
    switch (task.status) {
        case "queued":
            return "AI增强排队中，原图可用";
        case "running":
            return "AI增强进行中，原图可用";
        case "succeeded":
            return hasEnhanced ? "AI增强已完成" : refreshing ? "AI增强已完成，正在读取增强图片" : "AI增强已完成，增强图片暂未就绪，原图仍可用";
        case "failed":
            switch (task.reason) {
                case "connection_failed":
                case "authentication_failed":
                case "timeout":
                    return `AI增强失败，${ENHANCEMENT_REASONS[task.reason]}原图仍可用`;
                case "engine_failed":
                    return "AI增强失败，增强引擎执行失败，原图仍可用";
                case "output_invalid":
                    return "AI增强失败，增强结果摘要、尺寸或解码校验失败，原图仍可用";
                case "output_storage_invalid":
                    return "AI增强失败，增强图片保存失败，原图仍可用";
                default:
                    return "AI增强失败，原图仍可用";
            }
        case "cancelled":
            return "AI增强已取消，原图仍可用";
        case "skipped":
            return imageEnhancementSkipLabel({ status: "skipped", reason: task.reason });
    }
}

function imageEnhancementSkipLabel(value: unknown) {
    if (!value || typeof value !== "object" || !("status" in value) || value.status !== "skipped") return undefined;
    const reason = "reason" in value ? value.reason : undefined;
    switch (reason) {
        case "disabled":
            return "未启用AI增强";
        case "not_requested":
            return "本次未请求AI增强";
        case "protected_contract":
            return "保护图像保持原图";
        case "unsupported_layers":
            return "分层结果保持原图";
        case "aspect_ratio_mismatch":
            return "原图与请求比例不同，可按原图比例补做AI增强";
        case "native_sufficient":
            return "原图已达到请求尺寸，无需AI增强";
        case "provider_unavailable":
            return "增强服务未就绪，本次保留原图";
        case "already_enhanced":
            return "此图已是AI增强版本，不再重复增强";
        case "unsupported_transparency":
            return "当前增强服务不支持透明图，保留原图";
        case "unsupported_media_type":
            return "当前增强服务不支持此图片格式，保留原图";
        case "unsupported_target":
            return "请求尺寸超出单次4倍超分范围，保留原图";
        default:
            return "本次已跳过AI增强，原图仍可用";
    }
}
