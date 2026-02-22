"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { deleteTask, listTasks, type TaskListItem } from "@/lib/api";

const STATUS_CONFIG: Record<string, { label_key: string; cls: string; dot: string }> = {
  created:    { label_key: "status.created",    cls: "bg-slate-100 text-slate-600",      dot: "bg-slate-400" },
  processing: { label_key: "status.processing", cls: "bg-amber-50 text-amber-700 border border-amber-200",  dot: "bg-amber-500" },
  completed:  { label_key: "status.completed",  cls: "bg-emerald-50 text-emerald-700 border border-emerald-200", dot: "bg-emerald-500" },
  failed:     { label_key: "status.failed",     cls: "bg-red-50 text-red-600 border border-red-200",    dot: "bg-red-500" },
};

function TaskCard({ task, onDelete }: { task: TaskListItem; onDelete: (id: number) => void }) {
  const t = useTranslations("home");
  const tc = useTranslations("common");

  const status = STATUS_CONFIG[task.status] ?? STATUS_CONFIG.created;
  const progress =
    task.total_images > 0
      ? Math.round((task.completed_images / task.total_images) * 100)
      : 0;

  return (
    <div className="group relative flex flex-col rounded-2xl border border-[var(--color-border)] bg-[var(--color-card)] p-5 shadow-[var(--shadow-card)] transition-all duration-200 hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-md)] hover:-translate-y-0.5">
      {/* Header */}
      <div className="mb-3 flex items-start justify-between gap-3">
        <a
          href={`/tasks/${task.id}`}
          className="flex-1 text-[15px] font-semibold leading-snug text-[var(--color-text)] hover:text-[var(--color-primary)] transition-colors line-clamp-2"
        >
          {task.title}
        </a>
        {/* Status badge */}
        <span
          className={`flex-shrink-0 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${status.cls}`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${status.dot} ${task.status === "processing" ? "animate-pulse" : ""}`}
          />
          {t(status.label_key as any)}
        </span>
      </div>

      {/* Reference text preview */}
      <p className="mb-4 flex-1 text-sm text-[var(--color-text-secondary)] line-clamp-2 leading-relaxed">
        {task.reference_text_preview}
      </p>

      {/* Progress */}
      {task.total_images > 0 && (
        <div className="mb-4">
          <div className="mb-1.5 flex justify-between text-xs text-[var(--color-text-muted)]">
            <span>
              {t("images", { completed: task.completed_images, total: task.total_images })}
            </span>
            <span className="font-medium tabular-nums text-[var(--color-text-secondary)]">
              {progress}%
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full transition-all duration-700"
              style={{
                width: `${progress}%`,
                background: progress === 100
                  ? "linear-gradient(90deg, #16a34a, #22c55e)"
                  : "linear-gradient(90deg, #2563eb, #60a5fa)",
              }}
            />
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between">
        <time className="text-xs text-[var(--color-text-muted)]" dateTime={task.created_at}>
          {new Date(task.created_at).toLocaleDateString()}
        </time>
        <button
          onClick={(e) => {
            e.preventDefault();
            onDelete(task.id);
          }}
          className="cursor-pointer rounded-md px-2 py-1 text-xs text-[var(--color-text-muted)] opacity-0 transition-all hover:bg-red-50 hover:text-red-600 group-hover:opacity-100"
        >
          {tc("delete")}
        </button>
      </div>
    </div>
  );
}

function EmptyState() {
  const t = useTranslations("home");
  const tc = useTranslations("common");

  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-[var(--color-border)] py-20 text-center">
      {/* Illustration */}
      <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-2xl bg-[var(--color-primary-light)]">
        <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
          <rect x="6" y="8" width="28" height="24" rx="3" stroke="#2563eb" strokeWidth="1.5" fill="none"/>
          <path d="M12 16H28M12 21H22M12 26H18" stroke="#2563eb" strokeWidth="1.5" strokeLinecap="round"/>
          <circle cx="30" cy="30" r="6" fill="#2563eb"/>
          <path d="M30 27V33M27 30H33" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      </div>
      <p className="mb-1.5 text-base font-semibold text-[var(--color-text)]">
        {t("noTasks")}
      </p>
      <p className="mb-6 text-sm text-[var(--color-text-secondary)]">
        {t("noTasksHint")}
      </p>
      <a
        href="/new"
        className="inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-medium text-white transition-all hover:shadow-lg"
        style={{ background: "linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)" }}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M7 1V13M1 7H13" stroke="white" strokeWidth="2" strokeLinecap="round"/>
        </svg>
        {tc("newTask")}
      </a>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {[1, 2, 3].map((i) => (
        <div key={i} className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-card)] p-5">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div className="h-5 w-2/3 animate-pulse rounded-md bg-slate-100" />
            <div className="h-6 w-16 animate-pulse rounded-full bg-slate-100" />
          </div>
          <div className="mb-1 h-4 w-full animate-pulse rounded-md bg-slate-100" />
          <div className="mb-4 h-4 w-4/5 animate-pulse rounded-md bg-slate-100" />
          <div className="h-1.5 w-full animate-pulse rounded-full bg-slate-100" />
        </div>
      ))}
    </div>
  );
}

export default function HomePage() {
  const t = useTranslations("home");

  const [tasks, setTasks] = useState<TaskListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchTasks = async () => {
    try {
      setLoading(true);
      const data = await listTasks();
      setTasks(data.items);
      setTotal(data.total);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("loadError"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTasks();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDelete = async (taskId: number) => {
    if (!confirm(t("deleteConfirm"))) return;
    try {
      await deleteTask(taskId);
      await fetchTasks();
    } catch {
      alert(t("deleteError"));
    }
  };

  if (loading) return <LoadingSkeleton />;

  if (error) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="flex-shrink-0">
          <circle cx="8" cy="8" r="7" stroke="#dc2626" strokeWidth="1.5"/>
          <path d="M8 5V8.5M8 11H8.01" stroke="#dc2626" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
        {error}
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      {/* Page header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[var(--color-text)]">{t("title")}</h1>
          {total > 0 && (
            <p className="mt-0.5 text-sm text-[var(--color-text-secondary)]">
              {t("taskCount", { total })}
            </p>
          )}
        </div>
      </div>

      {tasks.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {tasks.map((task) => (
            <TaskCard key={task.id} task={task} onDelete={handleDelete} />
          ))}
        </div>
      )}
    </div>
  );
}
