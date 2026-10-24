"use client";

import { FileAudio2, Film } from "lucide-react";
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";

import { AgentMediaPreview } from "@/components/agent/agent-media-preview";
import type { CreativeAsset } from "@/lib/creative-runtime-contract";
import { imagePreviewUrl } from "@/lib/media-image-url";
import { cn } from "@/lib/utils";

import { creativeAssetLayout } from "./creative-asset-layout";
import { CreativeImageEnhancement } from "./creative-image-enhancement";
import { CreativeResultSwitcher, useSelectedCreativeResult } from "./creative-result-switcher";

const ACTIONS_MIN_WIDTH = 352;

export function CreativeMediaResult({
    assets,
    fallbackRatio,
    renderActions,
    onEnhancementComplete,
}: {
    assets: CreativeAsset[];
    fallbackRatio?: string;
    renderActions?: (activeAsset: CreativeAsset) => ReactNode;
    onEnhancementComplete?: (conversationId: string) => Promise<void>;
}) {
    const groups = useMemo(() => creativeMediaResultGroups(assets), [assets]);
    const results = useMemo(() => groups.map((group) => group.original), [groups]);
    const { selectedResult: original, selectedIndex, selectResult } = useSelectedCreativeResult(results);
    const enhanced = groups[selectedIndex]?.enhanced;
    const [selectedVariants, setSelectedVariants] = useState<Record<string, string>>({});
    const chosenId = original && selectedVariants[original.id];
    const activeAsset = chosenId ? (enhanced?.id === chosenId ? enhanced : original) : enhanced || original;
    const [loadedDimensions, setLoadedDimensions] = useState<Record<string, { width: number; height: number }>>({});
    if (!activeAsset || !original) return null;

    const sourceDimensions = validDimensions(activeAsset) || loadedDimensions[activeAsset.id] || {};
    const variant = activeAsset.type === "video" ? "video-result" : "image-result";
    const layout = creativeAssetLayout(sourceDimensions, { variant, ratio: fallbackRatio });
    const mediaWidth = activeAsset.type === "audio" ? `${ACTIONS_MIN_WIDTH}px` : String(layout?.container.width || `${ACTIONS_MIN_WIDTH}px`);
    const url = assetUrl(activeAsset);
    const resultStyle = { "--creative-result-media-width": mediaWidth } as CSSProperties;

    return (
        <div
            data-testid="creative-media-result"
            data-results-count={results.length}
            className={cn("grid w-fit max-w-full grid-cols-[minmax(0,1fr)] items-start", results.length > 1 && "sm:grid-cols-[var(--creative-result-media-width)_auto] sm:gap-x-3")}
            style={resultStyle}
        >
            {activeAsset.type === "audio" ? (
                <figure className="col-start-1 row-start-1 w-[352px] max-w-full rounded-xl border border-[#e7e9ee] bg-white p-4 dark:border-[#303640] dark:bg-[#181b20]">
                    <AgentMediaPreview type="audio" url={url} title={activeAsset.title || "生成音频"} />
                </figure>
            ) : (
                <figure
                    data-testid="creative-primary-result"
                    data-rendered-width={layout?.width}
                    data-rendered-height={layout?.height}
                    style={layout?.container}
                    className="relative col-start-1 row-start-1 max-w-full flex-none overflow-hidden rounded-xl border border-[#e4e7ec] bg-[#f8f9fb] shadow-[0_4px_18px_rgba(15,23,42,0.035)] dark:border-[#303640] dark:bg-[#15181c] dark:shadow-black/15"
                >
                    <AgentMediaPreview
                        type={activeAsset.type}
                        url={url}
                        title={activeAsset.title || (activeAsset.type === "video" ? "生成视频" : "生成图片")}
                        className="size-full"
                        fit="contain"
                        previewWidth={isEnhancedImageAsset(activeAsset) ? activeAsset.width : undefined}
                        onDimensions={(width, height) => {
                            if (width <= 0 || height <= 0 || validDimensions(activeAsset)) return;
                            setLoadedDimensions((current) => (current[activeAsset.id]?.width === width && current[activeAsset.id]?.height === height ? current : { ...current, [activeAsset.id]: { width, height } }));
                        }}
                    />
                </figure>
            )}

            <div className="col-start-1 row-start-2" style={{ width: mediaWidth, maxWidth: "100%" }}>
                {original.type === "image" ? (
                    <CreativeImageEnhancement
                        key={`${original.id}:${String(original.metadata.enhancementId || "")}`}
                        original={original}
                        enhanced={enhanced}
                        activeAssetId={activeAsset.id}
                        onSelect={(id) => setSelectedVariants((current) => ({ ...current, [original.id]: id }))}
                        onEnhancementComplete={onEnhancementComplete}
                    />
                ) : null}
                {renderActions?.(activeAsset)}
            </div>

            <CreativeResultSwitcher
                results={results}
                selectedIndex={selectedIndex}
                width={mediaWidth}
                height={layout?.height || 240}
                className="col-start-1 row-start-3 sm:col-start-2 sm:row-start-1"
                renderThumbnail={(asset, index) => {
                    const previewUrl = assetUrl(asset);
                    if (asset.type === "image") return <img src={imagePreviewUrl(previewUrl, 240)} alt={asset.title || `生成结果 ${index + 1}`} loading="lazy" className="size-full object-cover" />;
                    if (asset.type === "video") {
                        const coverUrl = typeof asset.metadata.coverUrl === "string" ? asset.metadata.coverUrl.trim() : "";
                        return coverUrl ? (
                            <img src={imagePreviewUrl(coverUrl, 240)} alt={asset.title || `生成视频 ${index + 1}`} loading="lazy" className="size-full object-cover" />
                        ) : (
                            <span className="grid size-full place-items-center text-[#667085] dark:text-[#a4adb8]" aria-label={asset.title || `生成视频 ${index + 1}`}>
                                <Film className="size-5" />
                            </span>
                        );
                    }
                    return <span className="grid size-full place-items-center text-[#667085] dark:text-[#a4adb8]">{asset.type === "audio" ? <FileAudio2 className="size-5" /> : <Film className="size-5" />}</span>;
                }}
                onSelect={selectResult}
            />
        </div>
    );
}

function validDimensions(asset: Pick<CreativeAsset, "width" | "height">) {
    const width = Number(asset.width);
    const height = Number(asset.height);
    return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height } : undefined;
}

function assetUrl(asset: CreativeAsset) {
    return asset.serverUrl || asset.remoteUrl || "";
}

export function creativeMediaResultGroups(assets: readonly CreativeAsset[]) {
    const available = assets.filter((asset) => asset.status === "ready" && asset.type !== "text" && assetUrl(asset));
    return available
        .filter((asset) => !isEnhancedImageAsset(asset))
        .map((original) => ({
            original,
            enhanced:
                original.type === "image"
                    ? available
                          .filter(
                              (asset) =>
                                  isEnhancedImageAsset(asset) &&
                                  asset.conversationId === original.conversationId &&
                                  (asset.parentAssetId
                                      ? asset.parentAssetId === original.id
                                      : typeof asset.metadata.parentResultId === "string"
                                        ? asset.metadata.parentResultId === original.metadata.resultId
                                        : typeof asset.metadata.enhancementId === "string" && asset.metadata.enhancementId === original.metadata.enhancementId),
                          )
                          .at(-1)
                    : undefined,
        }));
}

function isEnhancedImageAsset(asset: CreativeAsset) {
    return asset.type === "image" && asset.metadata.provenance === "ai_enhanced";
}
