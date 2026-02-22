"use client";

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import ImageViewer from "@/components/ImageViewer";
import AnnotationToolbar from "@/components/AnnotationToolbar";
import useAnnotationEditor from "@/components/AnnotationEditor";
import ExportEditorModal from "@/components/ExportEditorModal";
import DiffDisplay from "@/components/DiffDisplay";
import OcrTextEditor from "@/components/OcrTextEditor";
import { computeWordDiff, type DiffOp as DiffDisplayDiffOp } from "@/lib/diff";
import {
  correctOcr,
  getImageDetail,
  getOriginalImageUrl,
  getTask,
  listTaskImages,
  regenerateAnnotations,
  replaceAnnotations,
  type Annotation,
  type ImageDetail,
  type ImageListItem,
  type Task,
} from "@/lib/api";

export default function ImageReviewPage() {
  const params = useParams();
  const router = useRouter();
  const taskId = Number(params.taskId);
  const imageId = Number(params.imageId);

  const t = useTranslations("imageReview");
  const tc = useTranslations("common");

  const [task, setTask] = useState<Task | null>(null);
  const [image, setImage] = useState<ImageDetail | null>(null);
  const [allImages, setAllImages] = useState<ImageListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTool, setActiveTool] = useState<"select" | "ellipse" | "underline" | "caret">("select");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [localAnnotations, setLocalAnnotations] = useState<Annotation[]>([]);
  const [imageSize, setImageSize] = useState({ w: 800, h: 600 });
  const [editingOcrText, setEditingOcrText] = useState<string | null>(null);
  const [showExportModal, setShowExportModal] = useState(false);
  const [toast, setToast] = useState<{ message: string } | null>(null);

  const showToast = useCallback((message: string) => {
    setToast({ message });
    setTimeout(() => setToast(null), 3000);
  }, []);

  // Load data
  useEffect(() => {
    const load = async () => {
      try {
        const [t, img, imgs] = await Promise.all([
          getTask(taskId),
          getImageDetail(imageId),
          listTaskImages(taskId),
        ]);
        setTask(t);
        setImage(img);
        setAllImages(imgs);
        setLocalAnnotations(img.annotations);
      } catch (err) {
        console.error("Failed to load review data", err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [taskId, imageId]);

  const handleUndoRedoChange = useCallback((u: boolean, r: boolean) => {
    setCanUndo(u);
    setCanRedo(r);
  }, []);

  const editor = useAnnotationEditor({
    annotations: image?.annotations ?? [],
    imageWidth: imageSize.w,
    imageHeight: imageSize.h,
    activeTool,
    selectedId,
    onSelect: setSelectedId,
    onChange: setLocalAnnotations,
    onUndoRedoChange: handleUndoRedoChange,
  });

  // Navigation
  const currentIndex = allImages.findIndex((img) => img.id === imageId);
  const prevImage = currentIndex > 0 ? allImages[currentIndex - 1] : null;
  const nextImage = currentIndex < allImages.length - 1 ? allImages[currentIndex + 1] : null;

  const diffCount = image?.annotations.filter((a) => a.error_type !== "correct").length ?? 0;

  // Save annotations
  const handleSave = async () => {
    if (!image) return;
    try {
      setSaving(true);
      await replaceAnnotations(
        image.id,
        localAnnotations.map((a) => ({
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
          note: a.note,
          label_x: a.label_x,
          label_y: a.label_y,
          label_font_size: a.label_font_size,
        })),
      );
      // Reload image detail
      const updated = await getImageDetail(imageId);
      setImage(updated);
      showToast(t("saveSuccess"));
    } catch {
      alert(t("saveError"));
    } finally {
      setSaving(false);
    }
  };

  const handleOcrSave = async (text: string) => {
    if (!image) return;
    try {
      await correctOcr(image.id, text);
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const t = await getTask(taskId);
          if (t.status !== "processing") break;
        } catch {
          break;
        }
      }
      const updated = await getImageDetail(imageId);
      setImage(updated);
    } finally {
      setEditingOcrText(null);
    }
  };

  const handleRegenerate = async () => {
    if (!image) return;
    if (!confirm(t("regenerateConfirm"))) {
      return;
    }
    await regenerateAnnotations(image.id);
    setTimeout(async () => {
      const updated = await getImageDetail(imageId);
      setImage(updated);
      setLocalAnnotations(updated.annotations);
      showToast(t("regenerateSuccess"));
    }, 2000);
  };

  const handleExport = () => {
    if (!image) return;
    setShowExportModal(true);
  };

  // Derived values — must stay above early returns to satisfy Rules of Hooks
  const ocrWords = image?.ocr_words?.map((w) => w.text) ?? [];
  const refWords = task?.reference_words ?? [];

  // Live diff: recompute client-side while editing OCR text
  const liveDiffOps = useMemo(() => {
    if (editingOcrText === null || refWords.length === 0) return null;
    const editedWords = editingOcrText.split(/\s+/).filter(Boolean);
    return computeWordDiff(editedWords, refWords);
  }, [editingOcrText, refWords]);

  const displayDiffOps = liveDiffOps ?? (image?.diff_result as DiffDisplayDiffOp[] | null);
  const isLivePreview = liveDiffOps !== null;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--color-border)] border-t-[var(--color-primary)]" />
          <span className="text-sm text-[var(--color-text-secondary)]">{tc("loading")}</span>
        </div>
      </div>
    );
  }

  if (!image || !task) {
    return (
      <div className="py-20 text-center">
        <p className="text-red-500">{t("imageNotFound")}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <button
            onClick={() => router.push(`/tasks/${taskId}`)}
            className="flex-shrink-0 inline-flex cursor-pointer items-center gap-1 text-sm text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-primary)]"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M9 3L5 7L9 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            {t("back")}
          </button>
          <span className="text-[var(--color-border-strong)]">·</span>
          <h1 className="min-w-0 truncate text-base font-bold text-[var(--color-text)]">
            {image.label ?? `Image #${image.id}`}
          </h1>
          {diffCount > 0 && (
            <span className="flex-shrink-0 rounded-full border border-red-200 bg-red-50 px-2.5 py-0.5 text-xs font-semibold text-red-600">
              {t("diffCount", { count: diffCount })}
            </span>
          )}
        </div>
        {/* Navigation */}
        <div className="flex flex-shrink-0 items-center gap-2">
          {prevImage ? (
            <a
              href={`/tasks/${taskId}/images/${prevImage.id}`}
              className="inline-flex items-center gap-1 rounded-xl border border-[var(--color-border)] bg-white px-3 py-1.5 text-sm font-medium transition-all hover:border-[var(--color-border-strong)] hover:shadow-sm"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M7.5 2.5L4.5 6L7.5 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              {t("prev")}
            </a>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-xl border border-[var(--color-border)] bg-slate-50 px-3 py-1.5 text-sm text-[var(--color-text-muted)] cursor-not-allowed">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M7.5 2.5L4.5 6L7.5 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              {t("prev")}
            </span>
          )}
          <span className="text-xs tabular-nums text-[var(--color-text-muted)]">
            {currentIndex + 1} / {allImages.length}
          </span>
          {nextImage ? (
            <a
              href={`/tasks/${taskId}/images/${nextImage.id}`}
              className="inline-flex items-center gap-1 rounded-xl border border-[var(--color-border)] bg-white px-3 py-1.5 text-sm font-medium transition-all hover:border-[var(--color-border-strong)] hover:shadow-sm"
            >
              {t("next")}
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M4.5 2.5L7.5 6L4.5 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </a>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-xl border border-[var(--color-border)] bg-slate-50 px-3 py-1.5 text-sm text-[var(--color-text-muted)] cursor-not-allowed">
              {t("next")}
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M4.5 2.5L7.5 6L4.5 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </span>
          )}
        </div>
      </div>

      {/* Annotation Toolbar */}
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

      {/* Main content: Image viewer with annotation overlay */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Left: Original image */}
        <div className="overflow-hidden rounded-2xl border border-[var(--color-border)] shadow-[var(--shadow-sm)]">
          <div className="border-b border-[var(--color-border)] bg-slate-50 px-4 py-2.5 text-sm font-semibold text-[var(--color-text)]">
            {t("originalImage")}
          </div>
          <div style={{ height: 500 }}>
            <ImageViewer
              src={getOriginalImageUrl(image.id)}
              alt={image.label ?? "Original"}
            />
          </div>
        </div>

        {/* Right: Annotated view with interactive editor */}
        <div className="overflow-hidden rounded-2xl border border-[var(--color-border)] shadow-[var(--shadow-sm)]">
          <div className="border-b border-[var(--color-border)] bg-slate-50 px-4 py-2.5 text-sm font-semibold text-[var(--color-text)]">
            {t("annotationEditor")}
          </div>
          <div style={{ height: 500 }}>
            <ImageViewer
              src={getOriginalImageUrl(image.id)}
              alt="Annotated"
              overlay={editor.svgOverlay}
              onImageMouseDown={editor.handleMouseDown}
              onImageMouseMove={editor.handleMouseMove}
              onImageMouseUp={editor.handleMouseUp}
              onImageWheel={editor.handleWheel}
            />
          </div>
        </div>
      </div>

      {/* Text panels */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* Reference text */}
        <div className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-card)] shadow-[var(--shadow-sm)]">
          <div className="border-b border-[var(--color-border)] bg-slate-50 px-4 py-2.5 text-sm font-semibold text-[var(--color-text)]">
            {t("referenceText")}
          </div>
          <div className="p-4">
            <div className="rounded-xl bg-slate-50 p-3 font-mono text-sm leading-relaxed whitespace-pre-wrap text-[var(--color-text)]">
              {displayDiffOps
                ?.filter((op) => op.ref_index !== null)
                .map((op) => refWords[op.ref_index!] ?? op.reference_word)
                .join(" ") || (
                <span className="text-[var(--color-text-muted)]">—</span>
              )}
            </div>
          </div>
        </div>
        {/* OCR text editor */}
        <div className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-card)] shadow-[var(--shadow-sm)]">
          <div className="p-4">
            <OcrTextEditor
              initialText={image.ocr_raw_text ?? ""}
              onSave={handleOcrSave}
              onTextChange={setEditingOcrText}
            />
          </div>
        </div>
      </div>

      {/* Diff display */}
      {displayDiffOps && (
        <div className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-card)] shadow-[var(--shadow-sm)]">
          <div className="flex items-center gap-2 border-b border-[var(--color-border)] bg-slate-50 px-4 py-2.5">
            <span className="text-sm font-semibold text-[var(--color-text)]">
              {t("wordComparison")}
            </span>
            {isLivePreview && (
              <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-600">
                {t("live")}
              </span>
            )}
          </div>
          <div className="p-4">
            <DiffDisplay
              ocrWords={isLivePreview ? editingOcrText!.split(/\s+/).filter(Boolean) : ocrWords}
              referenceWords={refWords}
              diffOps={displayDiffOps as any}
            />
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex flex-wrap gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold text-white transition-all hover:shadow-md disabled:opacity-50"
          style={{ background: "linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)" }}
        >
          {saving ? (
            <>
              <svg className="animate-spin" width="13" height="13" viewBox="0 0 14 14" fill="none">
                <circle cx="7" cy="7" r="5.5" stroke="rgba(255,255,255,0.4)" strokeWidth="2"/>
                <path d="M7 1.5A5.5 5.5 0 0112.5 7" stroke="white" strokeWidth="2" strokeLinecap="round"/>
              </svg>
              {t("saving")}
            </>
          ) : t("saveCorrections")}
        </button>
        <button
          onClick={handleRegenerate}
          className="rounded-xl border border-[var(--color-border)] bg-white px-5 py-2.5 text-sm font-medium text-[var(--color-text-secondary)] transition-all hover:border-[var(--color-border-strong)] hover:bg-slate-50"
        >
          {t("regenerateAnnotations")}
        </button>
        <button
          onClick={handleExport}
          className="rounded-xl border border-[var(--color-border)] bg-white px-5 py-2.5 text-sm font-medium text-[var(--color-text-secondary)] transition-all hover:border-[var(--color-border-strong)] hover:bg-slate-50"
        >
          {t("exportAnnotatedImage")}
        </button>
      </div>

      {/* Export Editor Modal */}
      {showExportModal && image && (
        <ExportEditorModal
          imageId={image.id}
          annotations={localAnnotations}
          imageLabel={image.label}
          onClose={() => setShowExportModal(false)}
        />
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-xl bg-gray-900 px-5 py-3 text-sm text-white shadow-lg transition-all">
          {toast.message}
        </div>
      )}
    </div>
  );
}
