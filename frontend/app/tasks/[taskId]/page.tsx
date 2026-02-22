"use client";

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { usePolling } from "@/hooks/usePolling";
import SortableImageGrid from "@/components/SortableImageGrid";
import {
  exportTaskZip,
  getProgress,
  getTask,
  getTaskStats,
  listTaskImages,
  reorderImages,
  triggerProcessing,
  updateReferenceText,
  type ImageListItem,
  type ProgressData,
  type Task,
  type TaskStats,
} from "@/lib/api";

// -- Progress helpers --

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
  const ocrDone = p.images.filter(
    (i) => i.status !== "pending" && i.status !== "ocr_processing",
  ).length;
  const annotated = p.images.filter(
    (i) => i.status === "annotated" || i.status === "reviewed",
  ).length;
  const ocrPart = (ocrDone / p.total_images) * 0.6;
  const postPart = (annotated / p.total_images) * 0.4;
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
      return "bg-slate-100 text-slate-400";
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

// -- Stat card component --
function StatCard({
  value,
  label,
  accent,
}: {
  value: string | number;
  label: string;
  accent: "primary" | "green" | "red" | "blue" | "orange";
}) {
  const accentMap = {
    primary: { text: "text-[var(--color-primary)]", bg: "bg-[var(--color-primary-light)]", border: "border-blue-100" },
    green:   { text: "text-emerald-700", bg: "bg-emerald-50", border: "border-emerald-100" },
    red:     { text: "text-red-600", bg: "bg-red-50", border: "border-red-100" },
    blue:    { text: "text-blue-600", bg: "bg-blue-50", border: "border-blue-100" },
    orange:  { text: "text-orange-600", bg: "bg-orange-50", border: "border-orange-100" },
  };
  const { text, bg, border } = accentMap[accent];

  return (
    <div className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${bg} ${border}`}>
      <span className={`text-xl font-bold tabular-nums ${text}`}>{value}</span>
      <span className={`text-sm font-medium ${text} opacity-70`}>{label}</span>
    </div>
  );
}

// -- Main component --
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
  const [stats, setStats] = useState<TaskStats | null>(null);

  const [isEditingRef, setIsEditingRef] = useState(false);
  const [editingRefText, setEditingRefText] = useState("");
  const [savingRef, setSavingRef] = useState(false);
  const [exporting, setExporting] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [t, imgs] = await Promise.all([getTask(taskId), listTaskImages(taskId)]);
      setTask(t);
      setImages(imgs);
      if (t.status === "completed") {
        try {
          const s = await getTaskStats(taskId);
          setStats(s);
        } catch {}
      }
    } catch {}
    finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const { data: progress } = usePolling(
    () => getProgress(taskId),
    2000,
    (data) => data.status !== "processing",
    task?.status === "processing",
  );

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
    const reorderedImages = imageIds
      .map((id) => images.find((img) => img.id === id))
      .filter((img): img is ImageListItem => img !== undefined);
    setImages(reorderedImages);
    try {
      setReordering(true);
      const result = await reorderImages(taskId, imageIds);
      if (result.triggered_rediff) await fetchData();
    } catch {
      await fetchData();
    } finally {
      setReordering(false);
    }
  };

  const handleRefEdit = () => {
    setEditingRefText(task?.reference_text ?? "");
    setIsEditingRef(true);
  };

  const handleRefCancel = () => {
    setIsEditingRef(false);
    setEditingRefText("");
  };

  const handleRefSave = async () => {
    if (!editingRefText.trim()) return;
    try {
      setSavingRef(true);
      const updated = await updateReferenceText(taskId, editingRefText);
      setTask(updated);
      setIsEditingRef(false);
      setEditingRefText("");
      if (updated.status === "processing") await fetchData();
    } catch {
      alert(t("saveReferenceTextError"));
    } finally {
      setSavingRef(false);
    }
  };

  const handleExportZip = async () => {
    try {
      setExporting(true);
      await exportTaskZip(taskId);
    } catch {
      alert(t("exportZipError"));
    } finally {
      setExporting(false);
    }
  };

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

  if (!task) {
    return (
      <div className="py-20 text-center">
        <p className="text-red-500">{t("taskNotFound")}</p>
      </div>
    );
  }

  const pendingCount = images.filter((img) => img.status === "pending").length;
  const isProcessing = task.status === "processing";
  const dragDisabled = isProcessing || reordering;
  const pct = progress ? progressPercent(progress) : 0;

  return (
    <div className="animate-fade-in">
      {/* Page header */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <button
            onClick={() => router.push("/")}
            className="mb-2 inline-flex cursor-pointer items-center gap-1 text-sm text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-primary)]"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M9 3L5 7L9 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            {t("backToTasks")}
          </button>
          <h1 className="text-xl font-bold text-[var(--color-text)]">{task.title}</h1>
          <p className="mt-0.5 text-sm text-[var(--color-text-secondary)]">
            {t("imageCount", { total: task.total_images, completed: task.completed_images })}
          </p>
        </div>
        {pendingCount > 0 && (
          <button
            onClick={handleProcess}
            disabled={processing || isProcessing}
            className="flex-shrink-0 rounded-xl px-4 py-2 text-sm font-semibold text-white transition-all hover:shadow-md disabled:opacity-50"
            style={{ background: "linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)" }}
          >
            {isProcessing
              ? phaseLabel(progress?.current_phase ?? "ocr", progress ?? undefined)
              : t("processImages", { count: pendingCount })}
          </button>
        )}
      </div>

      {/* Stats row — completed tasks */}
      {task.status === "completed" && stats && (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-3">
            <StatCard value={`${stats.accuracy_pct}%`} label={t("stats.accuracy")} accent="primary" />
            <StatCard value={`✓ ${stats.correct}`} label={t("stats.correct")} accent="green" />
            <StatCard value={`✗ ${stats.wrong}`} label={t("stats.wrong")} accent="red" />
            <StatCard value={`+ ${stats.missing}`} label={t("stats.missing")} accent="blue" />
            <StatCard value={`− ${stats.extra}`} label={t("stats.extra")} accent="orange" />
          </div>
          <button
            onClick={handleExportZip}
            disabled={exporting}
            className="flex-shrink-0 inline-flex items-center gap-2 rounded-xl border border-[var(--color-border)] bg-white px-4 py-2 text-sm font-medium text-[var(--color-text-secondary)] transition-all hover:border-[var(--color-border-strong)] hover:bg-slate-50 disabled:opacity-50"
          >
            {exporting ? tc("loading") : t("exportAllZip")}
          </button>
        </div>
      )}

      {/* Progress panel */}
      {isProcessing && progress && (
        <div className="mb-5 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-card)] shadow-[var(--shadow-sm)]">
          <div className="px-5 pt-4 pb-2">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{
                    background: "var(--color-primary)",
                    animation: "pulse-dot 1.4s ease-in-out infinite",
                  }}
                />
                <span className="text-sm font-medium text-[var(--color-text)]">
                  {phaseLabel(progress.current_phase, progress)}
                </span>
              </div>
              <span className="text-xs font-semibold tabular-nums text-[var(--color-primary)]">
                {pct}%
              </span>
            </div>
            {/* Progress bar */}
            <div className="mb-3 h-2 overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full transition-all duration-700"
                style={{
                  width: `${pct}%`,
                  background: "linear-gradient(90deg, #2563eb, #60a5fa)",
                }}
              />
            </div>
          </div>
          {/* Image chips */}
          <div className="border-t border-[var(--color-border)] bg-slate-50 px-5 py-3">
            <div className="flex flex-wrap gap-1.5">
              {progress.images.map((img, idx) => (
                <div
                  key={img.id}
                  title={`${img.label ?? `Image ${idx + 1}`}: ${imageStatusLabel(img.status)}`}
                  className={`flex h-7 w-7 items-center justify-center rounded-md text-xs font-semibold ${imageChipStyle(img.status)}`}
                >
                  {imageChipIcon(img.status, idx)}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Reference Text */}
      <div className="mb-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-card)] shadow-[var(--shadow-sm)]">
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-3">
          <span className="text-sm font-semibold text-[var(--color-text)]">
            {t("referenceText")}
          </span>
          {!isEditingRef && !isProcessing && (
            <button
              onClick={handleRefEdit}
              className="cursor-pointer rounded-lg px-2.5 py-1 text-xs font-medium text-[var(--color-primary)] transition-colors hover:bg-[var(--color-primary-light)]"
            >
              {t("editReferenceText")}
            </button>
          )}
        </div>
        <div className="px-5 py-4">
          {isEditingRef ? (
            <div>
              <textarea
                value={editingRefText}
                onChange={(e) => setEditingRefText(e.target.value)}
                rows={6}
                className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3 font-mono text-sm leading-relaxed outline-none transition-all focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[var(--color-primary-ring)]"
                disabled={savingRef}
              />
              <div className="mt-3 flex gap-2">
                <button
                  onClick={handleRefSave}
                  disabled={savingRef || !editingRefText.trim()}
                  className="rounded-lg px-3.5 py-1.5 text-xs font-semibold text-white transition-all hover:shadow-sm disabled:opacity-50"
                  style={{ background: "linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)" }}
                >
                  {savingRef ? t("savingReferenceText") : t("saveReferenceText")}
                </button>
                <button
                  onClick={handleRefCancel}
                  disabled={savingRef}
                  className="rounded-lg border border-[var(--color-border)] px-3.5 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-slate-50 disabled:opacity-50"
                >
                  {tc("cancel")}
                </button>
              </div>
            </div>
          ) : (
            <p className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-[var(--color-text)]">
              {task.reference_text}
            </p>
          )}
        </div>
      </div>

      {/* Reordering / drag hint */}
      {reordering && (
        <div className="mb-3 flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
          <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[var(--color-border)] border-t-[var(--color-primary)]" />
          {t("savingOrder")}
        </div>
      )}
      {images.length > 1 && !dragDisabled && !reordering && (
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">{t("dragHint")}</p>
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
