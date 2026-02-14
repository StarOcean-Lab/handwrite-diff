"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import ImageViewer from "@/components/ImageViewer";
import useAnnotationEditor from "@/components/AnnotationEditor";
import { getOriginalImageUrl, renderExportImage, type Annotation } from "@/lib/api";

interface ExportEditorModalProps {
  imageId: number;
  annotations: Annotation[];
  imageLabel: string | null;
  onClose: () => void;
}

export default function ExportEditorModal({
  imageId,
  annotations: initialAnnotations,
  imageLabel,
  onClose,
}: ExportEditorModalProps) {
  const t = useTranslations("exportModal");
  const tc = useTranslations("common");

  // Deep copy to avoid mutating parent state
  const [annotations] = useState<Annotation[]>(() =>
    JSON.parse(JSON.stringify(initialAnnotations)),
  );
  const [scaleFactor, setScaleFactor] = useState(1.0);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [imageSize, setImageSize] = useState({ w: 800, h: 600 });
  const [localAnnotations, setLocalAnnotations] = useState<Annotation[]>(annotations);

  const containerRef = useRef<HTMLDivElement>(null);

  const handleUndoRedoChange = useCallback(() => {}, []);

  const editor = useAnnotationEditor({
    annotations,
    imageWidth: imageSize.w,
    imageHeight: imageSize.h,
    activeTool: "select",
    selectedId,
    annotationScale: scaleFactor,
    onSelect: setSelectedId,
    onChange: setLocalAnnotations,
    onUndoRedoChange: handleUndoRedoChange,
  });

  const selectedFontSize = (() => {
    if (!selectedId) return null;
    const found = localAnnotations.find((a) => `server_${a.id}` === selectedId || (a as any)._localId === selectedId);
    if (!found) return null;
    const bboxH = found.bbox_y2 - found.bbox_y1;
    return found.label_font_size != null && found.label_font_size > 0
      ? found.label_font_size
      : Math.max(Math.min(Math.round(bboxH * 0.5 * scaleFactor), 48 * scaleFactor), 10 * scaleFactor);
  })();

  // ESC to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // Prevent body scrolling while modal is open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  const handleDownload = async () => {
    setDownloading(true);
    setError(null);
    try {
      const annotationsWithFontSizes = localAnnotations.map((a) => {
        if (a.label_font_size != null && a.label_font_size > 0) return a;
        const bboxH = a.bbox_y2 - a.bbox_y1;
        const defaultFs = Math.max(
          Math.min(Math.round(bboxH * 0.5 * scaleFactor), 48 * scaleFactor),
          10 * scaleFactor,
        );
        return { ...a, label_font_size: defaultFs };
      });
      const blob = await renderExportImage(imageId, annotationsWithFontSizes, scaleFactor);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `annotated_${imageLabel || imageId}.jpg`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("downloadError"));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={handleOverlayClick}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div
        ref={containerRef}
        className="flex max-h-[90vh] w-full max-w-6xl flex-col rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-6 py-4">
          <h2 className="text-lg font-bold">{t("title")}</h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            aria-label={tc("close")}
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-4 border-b border-[var(--color-border)] bg-gray-50 px-6 py-3">
          <label className="text-sm font-medium text-[var(--color-text-secondary)]">
            {t("annotationScale")}
          </label>
          <input
            type="range"
            min={0.3}
            max={3.0}
            step={0.1}
            value={scaleFactor}
            onChange={(e) => setScaleFactor(parseFloat(e.target.value))}
            className="w-48"
          />
          <span className="min-w-[3rem] text-sm font-mono">
            {scaleFactor.toFixed(1)}x
          </span>
          <button
            onClick={() => setScaleFactor(1.0)}
            className="rounded border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-gray-100"
          >
            {tc("reset")}
          </button>
          {/* Font size slider — visible when an annotation is selected */}
          {selectedId && selectedFontSize != null && (
            <>
              <div className="mx-2 h-5 w-px bg-gray-300" />
              <label className="text-sm font-medium text-[var(--color-text-secondary)]">
                {t("fontSize")}
              </label>
              <input
                type="range"
                min={8}
                max={80}
                step={1}
                value={Math.round(selectedFontSize)}
                onChange={(e) => editor.changeFontSize(parseInt(e.target.value) - Math.round(selectedFontSize))}
                className="w-32"
              />
              <span className="min-w-[2.5rem] text-sm font-mono">
                {Math.round(selectedFontSize)}px
              </span>
            </>
          )}
          <span className="ml-auto text-xs text-[var(--color-text-secondary)]">
            {t("dragHint")}
          </span>
        </div>

        {/* Image Viewer */}
        <div className="min-h-0 flex-1 overflow-hidden" style={{ height: "60vh" }}>
          <ImageViewer
            src={getOriginalImageUrl(imageId)}
            alt={imageLabel ?? "Export preview"}
            overlay={editor.svgOverlay}
            onImageMouseDown={editor.handleMouseDown}
            onImageMouseMove={editor.handleMouseMove}
            onImageMouseUp={editor.handleMouseUp}
            onImageWheel={editor.handleWheel}
          />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-[var(--color-border)] px-6 py-4">
          <div>
            {error && (
              <span className="text-sm text-red-500">{error}</span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="rounded-lg border border-[var(--color-border)] px-5 py-2.5 text-sm font-medium hover:bg-gray-50"
            >
              {tc("cancel")}
            </button>
            <button
              onClick={handleDownload}
              disabled={downloading}
              className="rounded-lg bg-[var(--color-primary)] px-5 py-2.5 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
            >
              {downloading ? t("rendering") : tc("download")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
