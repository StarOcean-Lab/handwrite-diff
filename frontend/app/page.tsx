"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { deleteTask, listTasks, type TaskListItem } from "@/lib/api";

export default function HomePage() {
  const t = useTranslations("home");
  const tc = useTranslations("common");

  const statusBadge = (status: string): { label: string; color: string } => {
    const colors: Record<string, string> = {
      created: "bg-gray-100 text-gray-700",
      processing: "bg-yellow-100 text-yellow-700",
      completed: "bg-green-100 text-green-700",
      failed: "bg-red-100 text-red-700",
    };
    return {
      label: t(`status.${status}` as any),
      color: colors[status] ?? colors.created,
    };
  };

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

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-[var(--color-text-secondary)]">{tc("loading")}</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-center text-red-700">
        {error}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <span className="text-sm text-[var(--color-text-secondary)]">
          {t("taskCount", { total })}
        </span>
      </div>

      {tasks.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--color-border)] py-16 text-center">
          <p className="mb-2 text-lg font-medium text-[var(--color-text-secondary)]">
            {t("noTasks")}
          </p>
          <p className="mb-4 text-sm text-[var(--color-text-secondary)]">
            {t("noTasksHint")}
          </p>
          <a
            href="/new"
            className="inline-block rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm text-white hover:bg-[var(--color-primary-hover)]"
          >
            {tc("newTask")}
          </a>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {tasks.map((task) => {
            const badge = statusBadge(task.status);
            const progress =
              task.total_images > 0
                ? Math.round((task.completed_images / task.total_images) * 100)
                : 0;

            return (
              <div
                key={task.id}
                className="group rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-5 shadow-sm transition-shadow hover:shadow-md"
              >
                <div className="mb-3 flex items-start justify-between">
                  <a
                    href={`/tasks/${task.id}`}
                    className="text-lg font-semibold hover:text-[var(--color-primary)]"
                  >
                    {task.title}
                  </a>
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${badge.color}`}>
                    {badge.label}
                  </span>
                </div>

                <p className="mb-3 text-sm text-[var(--color-text-secondary)] line-clamp-2">
                  {task.reference_text_preview}
                </p>

                <div className="mb-3">
                  <div className="mb-1 flex justify-between text-xs text-[var(--color-text-secondary)]">
                    <span>
                      {t("images", { completed: task.completed_images, total: task.total_images })}
                    </span>
                    <span>{progress}%</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-gray-100">
                    <div
                      className="h-full rounded-full bg-[var(--color-primary)] transition-all"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between text-xs text-[var(--color-text-secondary)]">
                  <span>{new Date(task.created_at).toLocaleDateString()}</span>
                  <button
                    onClick={(e) => {
                      e.preventDefault();
                      handleDelete(task.id);
                    }}
                    className="text-red-500 opacity-0 transition-opacity hover:text-red-700 group-hover:opacity-100"
                  >
                    {tc("delete")}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
