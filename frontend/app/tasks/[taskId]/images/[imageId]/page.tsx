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
    return <div className="py-20 text-center text-[var(--color-text-secondary)]">{tc("loading")}</div>;
  }

  if (!image || !task) {
    return <div className="py-20 text-center text-red-500">{t("imageNotFound")}</div>;
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button
            onClick={() => router.push(`/tasks/${taskId}`)}
            className="text-sm text-[var(--color-primary)] hover:underline"
          >
            {t("back")}
          </button>
          <h1 className="text-lg font-bold">{image.label ?? `Image #${image.id}`}</h1>
          <span className="rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-700">
            {t("diffCount", { count: diffCount })}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {prevImage && (
            <a
              href={`/tasks/${taskId}/images/${prevImage.id}`}
              className="rounded border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-gray-50"
            >
              {t("prev")}
            </a>
          )}
          <span className="text-xs text-[var(--color-text-secondary)]">
            {currentIndex + 1} / {allImages.length}
          </span>
          {nextImage && (
            <a
              href={`/tasks/${taskId}/images/${nextImage.id}`}
              className="rounded border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-gray-50"
            >
              {t("next")}
            </a>
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
        <div className="overflow-hidden rounded-xl border border-[var(--color-border)]">
          <div className="border-b border-[var(--color-border)] bg-gray-50 px-3 py-2 text-sm font-medium">
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
        <div className="overflow-hidden rounded-xl border border-[var(--color-border)]">
          <div className="border-b border-[var(--color-border)] bg-gray-50 px-3 py-2 text-sm font-medium">
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
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-4">
          <h3 className="mb-2 text-sm font-medium text-[var(--color-text-secondary)]">
            {t("referenceText")}
          </h3>
          <p className="text-sm whitespace-pre-wrap">{task.reference_text}</p>
        </div>
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-4">
          <OcrTextEditor
            initialText={image.ocr_raw_text ?? ""}
            onSave={handleOcrSave}
            onTextChange={setEditingOcrText}
          />
        </div>
      </div>

      {/* Diff display */}
      {displayDiffOps && (
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-4">
          <h3 className="mb-3 text-sm font-medium text-[var(--color-text-secondary)]">
            {t("wordComparison")}
            {isLivePreview && (
              <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-600">
                {t("live")}
              </span>
            )}
          </h3>
          <DiffDisplay
            ocrWords={isLivePreview ? editingOcrText!.split(/\s+/).filter(Boolean) : ocrWords}
            referenceWords={refWords}
            diffOps={displayDiffOps as any}
          />
        </div>
      )}

      {/* Action buttons */}
      <div className="flex flex-wrap gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded-lg bg-[var(--color-primary)] px-5 py-2.5 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
        >
          {saving ? t("saving") : t("saveCorrections")}
        </button>
        <button
          onClick={handleRegenerate}
          className="rounded-lg border border-[var(--color-border)] px-5 py-2.5 text-sm font-medium hover:bg-gray-50"
        >
          {t("regenerateAnnotations")}
        </button>
        <button
          onClick={handleExport}
          className="rounded-lg border border-[var(--color-border)] px-5 py-2.5 text-sm font-medium hover:bg-gray-50"
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
    </div>
  );
}
