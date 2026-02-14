"use client";

import { useTranslations } from "next-intl";

interface AnnotationToolbarProps {
  activeTool: "select" | "ellipse" | "underline" | "caret";
  onToolChange: (tool: "select" | "ellipse" | "underline" | "caret") => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  selectedAnnotation: number | null;
  onDeleteSelected: () => void;
  onChangeType: (type: string) => void;
}

export default function AnnotationToolbar({
  activeTool,
  onToolChange,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  selectedAnnotation,
  onDeleteSelected,
  onChangeType,
}: AnnotationToolbarProps) {
  const t = useTranslations("toolbar");
  const tc = useTranslations("common");

  const tools = [
    { id: "select" as const, label: t("select"), icon: "👆" },
    { id: "ellipse" as const, label: t("ellipse"), icon: "⭕" },
    { id: "underline" as const, label: t("underline"), icon: "〰️" },
    { id: "caret" as const, label: t("caret"), icon: "^" },
  ];

  const errorTypes = [
    { value: "wrong", label: t("wrong"), color: "text-[var(--color-wrong)]" },
    { value: "extra", label: t("extra"), color: "text-[var(--color-extra)]" },
    { value: "missing", label: t("missing"), color: "text-[var(--color-missing)]" },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2">
      {/* Drawing tools */}
      <div className="flex gap-1">
        {tools.map((tool) => (
          <button
            key={tool.id}
            onClick={() => onToolChange(tool.id)}
            className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
              activeTool === tool.id
                ? "bg-[var(--color-primary)] text-white"
                : "hover:bg-gray-100"
            }`}
            title={tool.label}
          >
            {tool.icon} {tool.label}
          </button>
        ))}
      </div>

      <div className="h-5 w-px bg-[var(--color-border)]" />

      {/* Undo/Redo */}
      <div className="flex gap-1">
        <button
          onClick={onUndo}
          disabled={!canUndo}
          className="rounded-md px-2 py-1.5 text-xs hover:bg-gray-100 disabled:opacity-30"
          title={t("undoShortcut")}
        >
          ↩ {t("undo")}
        </button>
        <button
          onClick={onRedo}
          disabled={!canRedo}
          className="rounded-md px-2 py-1.5 text-xs hover:bg-gray-100 disabled:opacity-30"
          title={t("redoShortcut")}
        >
          ↪ {t("redo")}
        </button>
      </div>

      {/* Selection actions */}
      {selectedAnnotation !== null && (
        <>
          <div className="h-5 w-px bg-[var(--color-border)]" />
          <div className="flex items-center gap-1">
            <span className="text-xs text-[var(--color-text-secondary)]">{t("type")}</span>
            {errorTypes.map((et) => (
              <button
                key={et.value}
                onClick={() => onChangeType(et.value)}
                className={`rounded px-2 py-1 text-xs font-medium ${et.color} hover:bg-gray-100`}
              >
                {et.label}
              </button>
            ))}
            <button
              onClick={onDeleteSelected}
              className="ml-1 rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50"
            >
              🗑 {tc("delete")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
