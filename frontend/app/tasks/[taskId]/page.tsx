"use client";

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { usePolling } from "@/hooks/usePolling";
import SortableImageGrid from "@/components/SortableImageGrid";
import {
  getProgress,
  getTask,
  listTaskImages,
  reorderImages,
  triggerProcessing,
  type ImageListItem,
  type ProgressData,
  type Task,
} from "@/lib/api";

// -- Progress display helpers --

function usePhaseLabel() {
  const t = useTranslations("taskDetail");

  return (phase: string, p?: ProgressData): string => {
    if (!p) {
      const key = `phase.${phase}` as any;
      return t.has(key) ? t(key) : t("phase.processing");
    }

    const total = p.total_images;

    if (phase === "ocr") {
      const done = p.images.filter(
        (i) => i.status !== "pending" && i.status !== "ocr_processing",
      ).length;
      return t("phase.ocrProgress", { done, total });
    }
    if (phase === "diff") {
      const done = p.images.filter(
        (i) => i.status === "diff_done" || i.status === "annotated" || i.status === "reviewed",
      ).length;
      return t("phase.diffProgress", { done, total });
    }
    if (phase === "annotating") {
      const done = p.images.filter(
        (i) => i.status === "annotated" || i.status === "reviewed",
      ).length;
      return t("phase.annotatingProgress", { done, total });
    }
    if (phase === "completed") return t("phase.completed");
    if (phase === "failed") return t("phase.failed");
    return t("phase.processing");
  };
}

function progressPercent(p: ProgressData): number {
  if (p.total_images === 0) return 0;

  const ocrWeight = 0.6;
  const postWeight = 0.4;
  const ocrDone = p.images.filter(
    (i) => i.status !== "pending" && i.status !== "ocr_processing",
  ).length;
  const annotated = p.images.filter(
    (i) => i.status === "annotated" || i.status === "reviewed",
  ).length;

  const ocrPart = (ocrDone / p.total_images) * ocrWeight;
  const postPart = (annotated / p.total_images) * postWeight;
  return Math.min(100, Math.round((ocrPart + postPart) * 100));
}

function useImageStatusLabel() {
  const t = useTranslations("taskDetail");
  return (status: string): string => {
    const key = `imageStatus.${status}` as any;
    return t.has(key) ? t(key) : status;
  };
}

function imageChipStyle(status: string): string {
  switch (status) {
    case "annotated":
    case "reviewed":
      return "bg-emerald-100 text-emerald-700";
    case "ocr_done":
    case "diff_done":
      return "bg-blue-100 text-blue-700";
    case "ocr_processing":
      return "bg-amber-100 text-amber-700 animate-pulse";
    case "failed":
      return "bg-red-100 text-red-700";
    default:
      return "bg-gray-100 text-gray-400";
  }
}

function imageChipIcon(status: string, idx: number): React.ReactNode {
  switch (status) {
    case "annotated":
    case "reviewed":
      return "✓";
    case "failed":
      return "✗";
    case "ocr_processing":
      return "…";
    default:
      return idx + 1;
  }
}

export default function TaskDetailPage() {
  const params = useParams();
  const router = useRouter();
  const taskId = Number(params.taskId);

  const t = useTranslations("taskDetail");
  const tc = useTranslations("common");
  const phaseLabel = usePhaseLabel();
  const imageStatusLabel = useImageStatusLabel();

  const [task, setTask] = useState<Task | null>(null);
  const [images, setImages] = useState<ImageListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [reordering, setReordering] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [t, imgs] = await Promise.all([
        getTask(taskId),
        listTaskImages(taskId),
      ]);
      setTask(t);
      setImages(imgs);
    } catch {
      // Task might not exist
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Poll progress while processing
  const { data: progress } = usePolling(
    () => getProgress(taskId),
    2000,
    (data) => data.status !== "processing",
    task?.status === "processing",
  );

  // Refresh when processing completes
  useEffect(() => {
    if (progress && progress.status !== "processing") {
      fetchData();
    }
  }, [progress?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleProcess = async () => {
    try {
      setProcessing(true);
      await triggerProcessing(taskId);
      await fetchData();
    } catch {
      alert(t("processError"));
    } finally {
      setProcessing(false);
    }
  };

  const handleReorder = async (imageIds: number[]) => {
    // Optimistic UI: reorder locally first
    const reorderedImages = imageIds
      .map((id) => images.find((img) => img.id === id))
      .filter((img): img is ImageListItem => img !== undefined);
    setImages(reorderedImages);

    try {
      setReordering(true);
      const result = await reorderImages(taskId, imageIds);
      if (result.triggered_rediff) {
        await fetchData();
      }
    } catch {
      await fetchData();
    } finally {
      setReordering(false);
    }
  };

  if (loading) {
    return <div className="py-20 text-center text-[var(--color-text-secondary)]">{tc("loading")}</div>;
  }

  if (!task) {
    return <div className="py-20 text-center text-red-500">{t("taskNotFound")}</div>;
  }

  const pendingCount = images.filter((img) => img.status === "pending").length;
  const isProcessing = task.status === "processing";
  const dragDisabled = isProcessing || reordering;

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex items-start justify-between">
        <div>
          <button
            onClick={() => router.push("/")}
            className="mb-2 text-sm text-[var(--color-primary)] hover:underline"
          >
            {t("backToTasks")}
          </button>
          <h1 className="text-2xl font-bold">{task.title}</h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            {t("imageCount", { total: task.total_images, completed: task.completed_images })}
          </p>
        </div>
        {pendingCount > 0 && (
          <button
            onClick={handleProcess}
            disabled={processing || isProcessing}
            className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
          >
            {isProcessing
              ? phaseLabel(progress?.current_phase ?? "ocr", progress ?? undefined)
              : t("processImages", { count: pendingCount })}
          </button>
        )}
      </div>

      {/* Reference Text */}
      <div className="mb-6 rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-4">
        <h2 className="mb-2 text-sm font-medium text-[var(--color-text-secondary)]">
          {t("referenceText")}
        </h2>
        <p className="text-sm whitespace-pre-wrap">{task.reference_text}</p>
      </div>

      {/* Progress panel */}
      {isProcessing && progress && (
        <div className="mb-6 rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--color-primary)]" />
              <span className="text-sm font-medium">
                {phaseLabel(progress.current_phase, progress)}
              </span>
            </div>
            <span className="text-xs font-medium tabular-nums text-[var(--color-text-secondary)]">
              {progressPercent(progress)}%
            </span>
          </div>

          <div className="mb-3 h-2 overflow-hidden rounded-full bg-gray-100">
            <div
              className="h-full rounded-full bg-[var(--color-primary)] transition-all duration-500"
              style={{ width: `${progressPercent(progress)}%` }}
            />
          </div>

          <div className="flex flex-wrap gap-1.5">
            {progress.images.map((img, idx) => (
              <div
                key={img.id}
                title={`${img.label ?? `Image ${idx + 1}`}: ${imageStatusLabel(img.status)}`}
                className={`flex h-7 w-7 items-center justify-center rounded text-xs font-medium ${imageChipStyle(img.status)}`}
              >
                {imageChipIcon(img.status, idx)}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Reordering indicator */}
      {reordering && (
        <div className="mb-4 text-sm text-[var(--color-text-secondary)]">
          {t("savingOrder")}
        </div>
      )}

      {/* Drag hint */}
      {images.length > 1 && !dragDisabled && (
        <p className="mb-3 text-xs text-[var(--color-text-secondary)]">
          {t("dragHint")}
        </p>
      )}

      {/* Sortable Image Grid */}
      <SortableImageGrid
        images={images}
        taskId={taskId}
        disabled={dragDisabled}
        onReorder={handleReorder}
      />
    </div>
  );
}
