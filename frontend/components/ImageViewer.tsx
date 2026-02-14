"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

interface ImageViewerProps {
  src: string;
  alt?: string;
  /** Render overlay (SVG annotations) at the image's native coordinate space */
  overlay?: React.ReactNode;
  /** Callback when canvas is clicked (coordinates in image space) */
  onImageClick?: (x: number, y: number) => void;
  /** Callback for mouse events in image space. Return true to consume the event (prevents pan). */
  onImageMouseDown?: (x: number, y: number, e: React.MouseEvent) => boolean | void;
  onImageMouseMove?: (x: number, y: number, e: React.MouseEvent) => void;
  onImageMouseUp?: (x: number, y: number, e: React.MouseEvent) => void;
  /** Callback for wheel events. Return true to consume (prevents zoom). */
  onImageWheel?: (deltaY: number, ctrlKey: boolean) => boolean;
}

export default function ImageViewer({
  src,
  alt = "Image",
  overlay,
  onImageClick,
  onImageMouseDown,
  onImageMouseMove,
  onImageMouseUp,
  onImageWheel,
}: ImageViewerProps) {
  const t = useTranslations("imageViewer");
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [imageSize, setImageSize] = useState({ w: 0, h: 0 });

  const overlayActiveRef = useRef(false);

  const callbacksRef = useRef({
    toImageCoords: (clientX: number, clientY: number) => ({ x: 0, y: 0 }),
    onImageMouseMove: onImageMouseMove,
    onImageMouseUp: onImageMouseUp,
  });

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    if (onImageWheel && onImageWheel(e.deltaY, e.ctrlKey || e.metaKey)) {
      return;
    }
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setScale((prev) => Math.min(Math.max(prev * delta, 0.1), 10));
  }, [onImageWheel]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [handleWheel]);

  const toImageCoords = useCallback(
    (clientX: number, clientY: number) => {
      const container = containerRef.current;
      if (!container) return { x: 0, y: 0 };
      const rect = container.getBoundingClientRect();
      const x = (clientX - rect.left - offset.x) / scale;
      const y = (clientY - rect.top - offset.y) / scale;
      return { x, y };
    },
    [scale, offset],
  );

  useEffect(() => {
    callbacksRef.current.toImageCoords = toImageCoords;
    callbacksRef.current.onImageMouseMove = onImageMouseMove;
    callbacksRef.current.onImageMouseUp = onImageMouseUp;
  });

  useEffect(() => {
    const handleGlobalMove = (e: MouseEvent) => {
      if (!overlayActiveRef.current) return;
      const { toImageCoords: toCoords, onImageMouseMove: onMove } = callbacksRef.current;
      if (onMove) {
        const coords = toCoords(e.clientX, e.clientY);
        onMove(coords.x, coords.y, e as unknown as React.MouseEvent);
      }
    };
    const handleGlobalUp = (e: MouseEvent) => {
      if (!overlayActiveRef.current) return;
      overlayActiveRef.current = false;
      const { toImageCoords: toCoords, onImageMouseUp: onUp } = callbacksRef.current;
      if (onUp) {
        const coords = toCoords(e.clientX, e.clientY);
        onUp(coords.x, coords.y, e as unknown as React.MouseEvent);
      }
    };
    window.addEventListener("mousemove", handleGlobalMove);
    window.addEventListener("mouseup", handleGlobalUp);
    return () => {
      window.removeEventListener("mousemove", handleGlobalMove);
      window.removeEventListener("mouseup", handleGlobalUp);
    };
  }, []);

  const hasOverlayHandlers = !!(onImageMouseDown || onImageMouseMove || onImageMouseUp);
  const showGrabCursor = !hasOverlayHandlers;

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button === 1 || (e.button === 0 && e.altKey)) {
        setIsPanning(true);
        setPanStart({ x: e.clientX - offset.x, y: e.clientY - offset.y });
        e.preventDefault();
        return;
      }
      if (e.button === 0) {
        if (onImageMouseDown) {
          const coords = toImageCoords(e.clientX, e.clientY);
          const consumed = onImageMouseDown(coords.x, coords.y, e);
          if (consumed) {
            overlayActiveRef.current = true;
            return;
          }
        }
        setIsPanning(true);
        setPanStart({ x: e.clientX - offset.x, y: e.clientY - offset.y });
        e.preventDefault();
      }
    },
    [offset, toImageCoords, onImageMouseDown],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (isPanning) {
        setOffset({ x: e.clientX - panStart.x, y: e.clientY - panStart.y });
        return;
      }
      if (overlayActiveRef.current) return;
      if (onImageMouseMove) {
        const coords = toImageCoords(e.clientX, e.clientY);
        onImageMouseMove(coords.x, coords.y, e);
      }
    },
    [isPanning, panStart, toImageCoords, onImageMouseMove],
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (isPanning) {
        setIsPanning(false);
        return;
      }
      if (overlayActiveRef.current) return;
      if (onImageMouseUp) {
        const coords = toImageCoords(e.clientX, e.clientY);
        onImageMouseUp(coords.x, coords.y, e);
      }
    },
    [isPanning, toImageCoords, onImageMouseUp],
  );

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (onImageClick && !isPanning) {
        const coords = toImageCoords(e.clientX, e.clientY);
        onImageClick(coords.x, coords.y);
      }
    },
    [isPanning, toImageCoords, onImageClick],
  );

  const resetView = () => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  };

  const fitToContainer = () => {
    const container = containerRef.current;
    if (!container || imageSize.w === 0) return;
    const rect = container.getBoundingClientRect();
    const scaleX = rect.width / imageSize.w;
    const scaleY = rect.height / imageSize.h;
    setScale(Math.min(scaleX, scaleY, 1));
    setOffset({ x: 0, y: 0 });
  };

  return (
    <div className="flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] bg-gray-50 px-3 py-1.5">
        <button
          onClick={() => setScale((s) => Math.min(s * 1.2, 10))}
          className="rounded px-2 py-1 text-xs hover:bg-gray-200"
          title={t("zoomIn")}
        >
          🔍+
        </button>
        <button
          onClick={() => setScale((s) => Math.max(s * 0.8, 0.1))}
          className="rounded px-2 py-1 text-xs hover:bg-gray-200"
          title={t("zoomOut")}
        >
          🔍−
        </button>
        <button
          onClick={fitToContainer}
          className="rounded px-2 py-1 text-xs hover:bg-gray-200"
          title={t("fit")}
        >
          {t("fit")}
        </button>
        <button
          onClick={resetView}
          className="rounded px-2 py-1 text-xs hover:bg-gray-200"
          title={t("reset")}
        >
          {t("reset")}
        </button>
        <span className="ml-auto text-xs text-[var(--color-text-secondary)]">
          {Math.round(scale * 100)}%
        </span>
      </div>

      {/* Canvas */}
      <div
        ref={containerRef}
        className="relative flex-1 overflow-hidden bg-gray-100"
        style={{
          minHeight: 400,
          cursor: isPanning ? "grabbing" : showGrabCursor ? "grab" : "default",
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onClick={handleClick}
      >
        <div
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
            transformOrigin: "0 0",
            position: "relative",
            display: "inline-block",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={alt}
            draggable={false}
            onLoad={(e) => {
              const img = e.currentTarget;
              setImageSize({ w: img.naturalWidth, h: img.naturalHeight });
            }}
            style={{ display: "block", maxWidth: "none" }}
          />
          {/* SVG overlay at image native size */}
          {imageSize.w > 0 && (
            <svg
              width={imageSize.w}
              height={imageSize.h}
              className="pointer-events-none absolute top-0 left-0"
              style={{ pointerEvents: "none" }}
            >
              {overlay}
            </svg>
          )}
        </div>
      </div>
    </div>
  );
}
