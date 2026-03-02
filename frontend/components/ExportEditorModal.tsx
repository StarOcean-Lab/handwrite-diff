"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import ImageViewer from "@/components/ImageViewer";
import AnnotationToolbar from "@/components/AnnotationToolbar";
import useAnnotationEditor from "@/components/AnnotationEditor";
import { resolveOverlaps } from "@/lib/overlap";
import { getOriginalImageUrl, replaceAnnotations, type Annotation } from "@/lib/api";

type ToolType = "select" | "ellipse" | "underline" | "caret";

interface ExportEditorModalProps {
  imageId: number;
  annotations: Annotation[];
  imageLabel: string | null;
  /** Called on close; savedDraft=true means at least one draft save happened (parent should reload). */
  onClose: (savedDraft: boolean) => void;
}

// Mirrors AnnotationEditor TYPE_COLORS exactly — single source of truth for export rendering
const TYPE_COLORS: Record<string, { stroke: string; fill: string }> = {
  wrong:   { stroke: "#dc2626", fill: "rgba(220,38,38,0.08)" },
  extra:   { stroke: "#f97316", fill: "rgba(249,115,22,0.08)" },
  missing: { stroke: "#2563eb", fill: "rgba(37,99,235,0.08)" },
  correct: { stroke: "#16a34a", fill: "rgba(22,163,74,0.05)" },
};

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build an SVG string that exactly mirrors AnnotationEditor.renderAnnotation():
 * - Same shape geometry, colors, stroke widths, font sizes
 * - Same resolveOverlaps() label y-offset algorithm
 * - Same font family: Liberation Sans / Arial / Helvetica
 *
 * The resulting SVG is composited onto the export canvas so the download
 * is pixel-for-pixel identical to what the user sees in the editor.
 */
function buildAnnotationSvg(
  annotations: Annotation[],
  scaleFactor: number,
  imgWidth: number,
  imgHeight: number,
): string {
  // resolveOverlaps needs _localId; use stable index-based keys for export
  const withLocalId = annotations.map((a, i) => ({ ...a, _localId: `e${i}` }));
  const labelOffsets = resolveOverlaps(withLocalId);
  const s = scaleFactor;

  const parts: string[] = [];

  for (const a of withLocalId) {
    if (a.error_type === "correct") continue;

    const colors = TYPE_COLORS[a.error_type] ?? TYPE_COLORS.wrong;
    const strokeWidth = 2 * s;
    const bboxHeight = a.bbox_y2 - a.bbox_y1;
    const customFs = a.label_font_size;
    const fontSize =
      customFs != null && customFs > 0
        ? customFs
        : Math.max(
            Math.min(Math.round(bboxHeight * 0.5 * s), 48 * s),
            10 * s,
          );
    const labelYOffset = labelOffsets.get(a._localId) ?? 0;

    // Mirror renderLabel(defaultX, defaultY) in AnnotationEditor
    const labelSvg = (defaultX: number, defaultY: number): string => {
      if (!a.reference_word) return "";
      const lx = a.label_x ?? defaultX;
      const ly = a.label_y ?? (defaultY + labelYOffset);
      return (
        `<text x="${lx}" y="${ly}" text-anchor="middle"` +
        ` fill="${colors.stroke}" font-size="${fontSize}" font-weight="bold"` +
        ` font-family="Liberation Sans, Arial, Helvetica, sans-serif">` +
        `${xmlEscape(a.reference_word)}</text>`
      );
    };

    if (a.annotation_shape === "ellipse") {
      const cx = (a.bbox_x1 + a.bbox_x2) / 2;
      const cy = (a.bbox_y1 + a.bbox_y2) / 2;
      const rx = (a.bbox_x2 - a.bbox_x1) / 2 + 4 * s;
      const ry = (a.bbox_y2 - a.bbox_y1) / 2 + 3 * s;
      parts.push(
        `<g>` +
        `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}"` +
        ` fill="${colors.fill}" stroke="${colors.stroke}" stroke-width="${strokeWidth}"` +
        ` stroke-linecap="round" stroke-linejoin="round"/>` +
        labelSvg(cx, a.bbox_y1 - 8 * s) +
        `</g>`,
      );
    } else if (a.annotation_shape === "underline") {
      const lineY = a.bbox_y2 + 2 * s;
      const midY = (a.bbox_y1 + a.bbox_y2) / 2;
      parts.push(
        `<g>` +
        `<line x1="${a.bbox_x1}" y1="${lineY}" x2="${a.bbox_x2}" y2="${lineY}"` +
        ` stroke="${colors.stroke}" stroke-width="${strokeWidth + s}" stroke-linecap="round"/>` +
        `<line x1="${a.bbox_x1}" y1="${midY}" x2="${a.bbox_x2}" y2="${midY}"` +
        ` stroke="${colors.stroke}" stroke-width="${strokeWidth}" stroke-linecap="round" opacity="0.5"/>` +
        `</g>`,
      );
    } else if (a.annotation_shape === "caret") {
      const cx = (a.bbox_x1 + a.bbox_x2) / 2;
      const top = a.bbox_y1;
      const bottom = a.bbox_y2;
      parts.push(
        `<g>` +
        `<polyline points="${cx - 8 * s},${bottom} ${cx},${top} ${cx + 8 * s},${bottom}"` +
        ` fill="none" stroke="${colors.stroke}" stroke-width="${strokeWidth}"` +
        ` stroke-linecap="round" stroke-linejoin="round"/>` +
        labelSvg(cx, top - 6 * s) +
        `</g>`,
      );
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${imgWidth}" height="${imgHeight}">` +
    parts.join("") +
    `</svg>`
  );
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
  const [localAnnotations, setLocalAnnotations] = useState<Annotation[]>(() =>
    JSON.parse(JSON.stringify(initialAnnotations)),
  );
  const [scaleFactor, setScaleFactor] = useState(1.0);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [imageSize, setImageSize] = useState({ w: 800, h: 600 });

  // Drawing tools state
  const [activeTool, setActiveTool] = useState<ToolType>("select");
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  // Save draft state
  const [savingDraft, setSavingDraft] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);
  const draftSavedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track whether a draft was ever saved this session (to notify parent on close)
  const [draftEverSaved, setDraftEverSaved] = useState(false);

  // Dirty tracking: compare JSON snapshots to detect unsaved changes
  const [savedAnnotationsJson, setSavedAnnotationsJson] = useState(
    () => JSON.stringify(initialAnnotations),
  );
  const isDirty = useMemo(
    () => JSON.stringify(localAnnotations) !== savedAnnotationsJson,
    [localAnnotations, savedAnnotationsJson],
  );

  const containerRef = useRef<HTMLDivElement>(null);

  const handleUndoRedoChange = useCallback((u: boolean, r: boolean) => {
    setCanUndo(u);
    setCanRedo(r);
  }, []);

  const editor = useAnnotationEditor({
    annotations: localAnnotations,
    imageWidth: imageSize.w,
    imageHeight: imageSize.h,
    activeTool,
    selectedId,
    annotationScale: scaleFactor,
    onSelect: setSelectedId,
    onChange: setLocalAnnotations,
    onUndoRedoChange: handleUndoRedoChange,
  });

  // Use the editor's direct accessor to avoid the _localId stripping problem:
  // fromLocal() strips _localId, so newly drawn annotations (id=0) can't be
  // found by matching selectedId in localAnnotations.
  const selectedAnnotation = editor.selectedAnnotationData;

  /** Whether the selected annotation supports a user-editable reference word */
  const showReferenceWordInput =
    selectedAnnotation !== null &&
    (selectedAnnotation.error_type === "wrong" || selectedAnnotation.error_type === "missing");

  const selectedFontSize = (() => {
    if (!selectedAnnotation) return null;
    const bboxH = selectedAnnotation.bbox_y2 - selectedAnnotation.bbox_y1;
    return selectedAnnotation.label_font_size != null && selectedAnnotation.label_font_size > 0
      ? selectedAnnotation.label_font_size
      : Math.max(Math.min(Math.round(bboxH * 0.5 * scaleFactor), 48 * scaleFactor), 10 * scaleFactor);
  })();

  /** Serialize annotations for replaceAnnotations API call */
  const serializeAnnotations = useCallback(
    (anns: Annotation[]) =>
      anns.map((a) => ({
        word_index: a.word_index,
        ocr_word: a.ocr_word,
        reference_word: a.reference_word,
        error_type: a.error_type,
        annotation_shape: a.annotation_shape,
        bbox_x1: a.bbox_x1,
        bbox_y1: a.bbox_y1,
        bbox_x2: a.bbox_x2,
        bbox_y2: a.bbox_y2,
        is_auto: a.is_auto,
        is_user_corrected: a.is_user_corrected,
        note: a.note,
        label_x: a.label_x,
        label_y: a.label_y,
        label_font_size: a.label_font_size,
      })),
    [],
  );

  /** Save draft to backend */
  const handleSaveDraft = useCallback(async () => {
    setSavingDraft(true);
    setError(null);
    try {
      await replaceAnnotations(imageId, serializeAnnotations(localAnnotations));
      setSavedAnnotationsJson(JSON.stringify(localAnnotations));
      setDraftEverSaved(true);
      setDraftSaved(true);
      // Clear previous timer to avoid overlapping resets
      if (draftSavedTimerRef.current) clearTimeout(draftSavedTimerRef.current);
      draftSavedTimerRef.current = setTimeout(() => setDraftSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("saveDraftError"));
    } finally {
      setSavingDraft(false);
    }
  }, [imageId, localAnnotations, serializeAnnotations, t]);

  /** Close with dirty-check confirmation */
  const handleClose = useCallback(() => {
    if (isDirty && !window.confirm(t("unsavedChangesConfirm"))) return;
    onClose(draftEverSaved);
  }, [isDirty, draftEverSaved, onClose, t]);

  // ESC to close (with dirty check)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        handleClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleClose]);

  // Prevent body scrolling while modal is open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Clear draft-saved timer on unmount
  useEffect(() => {
    return () => {
      if (draftSavedTimerRef.current) clearTimeout(draftSavedTimerRef.current);
    };
  }, []);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      handleClose();
    }
  };

  /**
   * SVG-composite export — draws the original image, then overlays an SVG
   * built from the same rendering logic as AnnotationEditor (same shapes,
   * colors, font family, label offsets via resolveOverlaps).
   *
   * This guarantees the downloaded JPEG is pixel-for-pixel identical to what
   * the user sees in the editor — true WYSIWYG export.
   */
  const handleDownload = async () => {
    setDownloading(true);
    setError(null);
    try {
      // Fetch the original image and decode it as a bitmap
      const resp = await fetch(getOriginalImageUrl(imageId));
      if (!resp.ok) throw new Error(`Failed to fetch image: ${resp.status}`);
      const imgBlob = await resp.blob();
      const bitmap = await createImageBitmap(imgBlob);

      // Create an off-screen canvas at full image resolution
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas 2D context unavailable");

      // 1. Draw the original (unprocessed) image
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();

      // 2. Build SVG overlay — mirrors AnnotationEditor rendering exactly
      const svgStr = buildAnnotationSvg(
        localAnnotations,
        scaleFactor,
        canvas.width,
        canvas.height,
      );
      const svgBlob = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" });
      const svgUrl = URL.createObjectURL(svgBlob);
      try {
        const svgImg = new Image();
        await new Promise<void>((resolve, reject) => {
          svgImg.onload = () => resolve();
          svgImg.onerror = () => reject(new Error("Failed to render SVG overlay"));
          svgImg.src = svgUrl;
        });
        ctx.drawImage(svgImg, 0, 0, canvas.width, canvas.height);
      } finally {
        URL.revokeObjectURL(svgUrl);
      }

      // 3. Export as PNG blob (lossless — preserves annotation sharpness)
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("Canvas.toBlob returned null"))),
          "image/png",
        );
      });

      // 4. Trigger browser download
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `annotated_${imageLabel || imageId}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
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
            onClick={handleClose}
            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            aria-label={tc("close")}
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Drawing Toolbar */}
        <div className="border-b border-[var(--color-border)] bg-gray-50 px-4 py-2">
          <AnnotationToolbar
            activeTool={activeTool}
            onToolChange={setActiveTool}
            canUndo={canUndo}
            canRedo={canRedo}
            onUndo={editor.undo}
            onRedo={editor.redo}
            selectedAnnotation={selectedId ? 1 : null}
            onDeleteSelected={editor.deleteSelected}
            onChangeType={editor.changeType}
          />
        </div>

        {/* Scale / Font-size Toolbar */}
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
          {/* Reference word input — visible for wrong / missing annotations */}
          {showReferenceWordInput && selectedAnnotation && (
            <>
              <div className="mx-2 h-5 w-px bg-gray-300" />
              <label className="text-sm font-medium text-[var(--color-text-secondary)]">
                {t("correctContent")}
              </label>
              <input
                type="text"
                value={selectedAnnotation.reference_word ?? ""}
                onChange={(e) => editor.changeReferenceWord(e.target.value)}
                placeholder={t("correctContentPlaceholder")}
                className={`w-36 rounded border px-2 py-1 text-sm outline-none focus:ring-1 ${
                  selectedAnnotation.error_type === "wrong"
                    ? "border-red-300 focus:border-red-400 focus:ring-red-200"
                    : "border-blue-300 focus:border-blue-400 focus:ring-blue-200"
                }`}
              />
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
          {/* Left: feedback messages */}
          <div className="flex items-center gap-3">
            {error && (
              <span className="text-sm text-red-500">{error}</span>
            )}
            {draftSaved && !error && (
              <span className="flex items-center gap-1 text-sm text-green-600">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M2.5 7L5.5 10L11.5 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                {t("saveDraftSuccess")}
              </span>
            )}
          </div>

          {/* Right: action buttons */}
          <div className="flex items-center gap-3">
            <button
              onClick={handleClose}
              className="rounded-lg border border-[var(--color-border)] px-5 py-2.5 text-sm font-medium hover:bg-gray-50"
            >
              {tc("cancel")}
            </button>
            <button
              onClick={handleSaveDraft}
              disabled={savingDraft || !isDirty}
              className="rounded-lg border border-[var(--color-border)] px-5 py-2.5 text-sm font-medium text-[var(--color-text-secondary)] hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {savingDraft ? t("savingDraft") : t("saveDraft")}
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
