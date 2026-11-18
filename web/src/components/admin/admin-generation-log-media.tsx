"use client";

import { useState } from "react";
import { Button } from "antd";

import { AgentMediaPreview } from "@/components/agent/agent-media-preview";
import { browserReadableMediaUrl } from "@/lib/browser-media-url";
import { originalMediaDownloadUrl } from "@/lib/media-image-url";
import type { GenerationLogAsset } from "@/lib/server/generation-log-types";

export function GenerationLogMediaResult({ asset, index }: { asset: GenerationLogAsset; index: number }) {
    const [selection, setSelection] = useState<"native" | "delivered" | null>(null);
    const enhancement = asset.enhancement;
    const native = enhancement?.native || asset.nativeSource;
    const delivered = asset.type === "image" && enhancement?.status === "succeeded" && enhancement.enhanced?.url.trim() ? enhancement.enhanced : undefined;
    const showDelivered = Boolean(delivered) && selection !== "native";
    const nativeUrl = browserReadableMediaUrl(native?.url || generationLogAssetAccessUrl(asset));
    const deliveredUrl = delivered ? browserReadableMediaUrl(delivered.url) : "";
    const selectedUrl = showDelivered ? deliveredUrl : nativeUrl;
    const selectedFile = (showDelivered ? delivered : native) || {
        width: asset.width,
        height: asset.height,
        byteLength: asset.bytes,
        format: asset.mimeType?.split(";", 1)[0]?.split("/", 2)[1],
        sha256: undefined,
    };
    const resultId = asset.resultId || enhancement?.resultId;
    const mediaLabel = `${asset.type === "video" ? "视频" : "图片"} ${index + 1}`;
    const versionLabel = showDelivered ? "交付图" : "原图";
    const title = [mediaLabel, asset.type === "image" ? versionLabel : "", resultId].filter(Boolean).join(" · ");

    return (
        <section className="min-w-0 space-y-2" data-testid="generation-log-media-result" data-result-id={resultId}>
            <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium text-foreground">{mediaLabel}</span>
                {delivered ? (
                    <div className="flex gap-1" role="group" aria-label={`${mediaLabel}版本`}>
                        <Button size="small" type={showDelivered ? "default" : "primary"} aria-pressed={!showDelivered} onClick={() => setSelection("native")}>
                            原图
                        </Button>
                        <Button size="small" type={showDelivered ? "primary" : "default"} aria-pressed={showDelivered} onClick={() => setSelection("delivered")}>
                            交付图
                        </Button>
                    </div>
                ) : null}
            </div>
            <div className="grid min-w-0 grid-cols-[200px_minmax(0,1fr)] items-start gap-3">
                {asset.type === "video" ? (
                    <video className="h-40 w-full rounded-md bg-black object-contain" src={nativeUrl} controls playsInline preload="metadata" aria-label={title} />
                ) : (
                    <AgentMediaPreview type="image" url={selectedUrl} title={title} fit="contain" className="h-40 w-full rounded-md bg-muted" />
                )}
                <div className="min-w-0 space-y-2 text-xs text-muted-foreground">
                    {asset.type === "image" ? <div className="font-medium text-foreground">{versionLabel}</div> : null}
                    <dl className="space-y-1">
                        <div className="flex flex-wrap gap-x-2">
                            <dt>实际尺寸</dt>
                            <dd className="tabular-nums">{selectedFile.width && selectedFile.height ? `${selectedFile.width} × ${selectedFile.height}` : "尺寸未记录"}</dd>
                        </div>
                        <div className="flex flex-wrap gap-x-2">
                            <dt>文件格式</dt>
                            <dd>{selectedFile.format?.toUpperCase() || "格式未记录"}</dd>
                        </div>
                        <div className="flex flex-wrap gap-x-2">
                            <dt>文件大小</dt>
                            <dd>{selectedFile.byteLength !== undefined ? formatAssetBytes(selectedFile.byteLength) : "大小未记录"}</dd>
                        </div>
                        <div>
                            <dt className="inline">结果 ID：</dt>
                            <dd className="inline break-all font-mono">{resultId || "未记录"}</dd>
                        </div>
                        {selectedFile.sha256 ? (
                            <div>
                                <dt className="inline">SHA-256：</dt>
                                <dd className="inline break-all font-mono">{selectedFile.sha256}</dd>
                            </div>
                        ) : null}
                    </dl>
                    <div className="flex flex-wrap gap-2">
                        {nativeUrl ? (
                            <Button size="small" href={originalMediaDownloadUrl(nativeUrl)} download>
                                {asset.type === "video" ? "下载视频" : "下载原图"}
                            </Button>
                        ) : null}
                        {delivered ? (
                            <Button size="small" href={originalMediaDownloadUrl(deliveredUrl)} download>
                                下载交付图
                            </Button>
                        ) : null}
                    </div>
                </div>
            </div>
        </section>
    );
}

export function generationLogAssetAccessUrl(asset: GenerationLogAsset) {
    const directUrl = asset.url && !asset.url.startsWith("/api/generation-log-assets/") && asset.url !== asset.serverUrl ? asset.url : "";
    const serverUrl = asset.serverUrl || (asset.url?.startsWith("/api/generation-log-assets/") ? asset.url : "");
    return browserReadableMediaUrl(serverUrl || asset.remoteUrl || directUrl);
}

function formatAssetBytes(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
