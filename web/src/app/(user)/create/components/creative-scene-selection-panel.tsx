"use client";

import { Button } from "antd";
import { useRef, useState, type PointerEvent } from "react";
import { imagePreviewUrl } from "@/lib/media-image-url";
import type { CreativeAgentRun, CreativeSceneSelection } from "@/services/api/creative";
import { sceneSelectionPoint, sceneSelectionRegion, type SceneSelectionPoint } from "./creative-scene-selection";

export function CreativeSceneSelectionPanel({ runId, action, onConfirm }: { runId: string; action: NonNullable<CreativeAgentRun["ecommerceSceneSelection"]>; onConfirm: (runId: string, selection: CreativeSceneSelection) => Promise<void> }) {
    const imageRef = useRef<HTMLImageElement>(null);
    const startRef = useRef<SceneSelectionPoint | undefined>(undefined);
    const confirmingRef = useRef(false);
    const [open, setOpen] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const [region, setRegion] = useState<CreativeSceneSelection["region"]>();
    const [confirming, setConfirming] = useState(false);
    const [error, setError] = useState("");
    const point = (event: PointerEvent<HTMLDivElement>) => (imageRef.current && loaded ? sceneSelectionPoint({ x: event.clientX, y: event.clientY }, imageRef.current.getBoundingClientRect(), action) : undefined);
    const updateRegion = (event: PointerEvent<HTMLDivElement>) => {
        const end = point(event);
        if (startRef.current && end) setRegion(sceneSelectionRegion(startRef.current, end));
    };
    const wholeImage = region?.width === action.width && region.height === action.height;
    const confirm = async () => {
        if (!region || wholeImage || confirmingRef.current) return;
        confirmingRef.current = true;
        setConfirming(true);
        setError("");
        try {
            await onConfirm(runId, { baselineAssetId: action.baselineAssetId, region });
            setOpen(false);
            setRegion(undefined);
        } catch {
            setError("修改位置未能确认，请刷新后重试。");
        } finally {
            confirmingRef.current = false;
            setConfirming(false);
        }
    };
    if (!open)
        return (
            <Button
                className="mt-3"
                onClick={() => {
                    setOpen(true);
                    setLoaded(false);
                    setRegion(undefined);
                    setError("");
                }}
            >
                选择修改位置
            </Button>
        );
    return (
        <div data-testid="creative-scene-selection" className="mt-3 w-full min-w-0 max-w-[520px] space-y-3">
            <p className="text-sm leading-6">在原图上拖选要修改的位置，包含新增物体及其接触阴影。</p>
            <div
                className="relative max-w-full overflow-hidden rounded-md"
                style={{ width: Math.min(action.width, 520), touchAction: "none" }}
                onPointerDown={(event) => {
                    if (confirmingRef.current || (event.pointerType === "mouse" && event.button !== 0)) return;
                    const start = point(event);
                    if (!start) return;
                    event.preventDefault();
                    startRef.current = start;
                    setRegion(undefined);
                    event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                    if (!confirmingRef.current) updateRegion(event);
                }}
                onPointerUp={(event) => {
                    if (!confirmingRef.current) updateRegion(event);
                    startRef.current = undefined;
                    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                }}
                onPointerCancel={() => {
                    startRef.current = undefined;
                    setRegion(undefined);
                }}
            >
                <img
                    ref={imageRef}
                    src={imagePreviewUrl(action.url)}
                    alt="选择修改位置的原图"
                    width={action.width}
                    height={action.height}
                    className="block h-auto w-full select-none"
                    draggable={false}
                    onLoad={() => setLoaded(true)}
                    onError={() => {
                        setLoaded(false);
                        setError("原图暂时无法读取，请刷新后重试。");
                    }}
                />
                {region ? (
                    <div
                        aria-hidden
                        className="pointer-events-none absolute border-2 border-primary bg-primary/15"
                        style={{ left: `${(region.x / action.width) * 100}%`, top: `${(region.y / action.height) * 100}%`, width: `${(region.width / action.width) * 100}%`, height: `${(region.height / action.height) * 100}%` }}
                    />
                ) : null}
            </div>
            {wholeImage ? <p className="text-sm text-amber-700 dark:text-amber-300">请只选择需要修改的局部位置。</p> : null}
            {error ? (
                <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">
                    {error}
                </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
                <Button type="primary" loading={confirming} disabled={!loaded || !region || wholeImage || confirming} onClick={() => void confirm()}>
                    确认修改位置
                </Button>
                <Button
                    disabled={confirming}
                    onClick={() => {
                        setOpen(false);
                        setRegion(undefined);
                        startRef.current = undefined;
                    }}
                >
                    取消选择
                </Button>
            </div>
        </div>
    );
}
