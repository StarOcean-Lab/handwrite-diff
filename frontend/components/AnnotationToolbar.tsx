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

// SVG icons for tools — no emoji
function IconSelect() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <path d="M2 2L6 11L7.5 7.5L11 6L2 2Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
    </svg>
  );
}
function IconEllipse() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <ellipse cx="6.5" cy="6.5" rx="5" ry="4" stroke="currentColor" strokeWidth="1.3"/>
    </svg>
  );
}
function IconUnderline() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <path d="M3 4V7C3 8.657 4.343 10 6 10C7.657 10 9 8.657 9 7V4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      <line x1="2" y1="11.5" x2="10" y2="11.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
    </svg>
  );
}
function IconCaret() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <path d="M6.5 2V10M4 4.5L6.5 2L9 4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}
function IconUndo() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <path d="M2 5.5H8.5C9.88 5.5 11 6.62 11 8C11 9.38 9.88 10.5 8.5 10.5H5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      <path d="M4.5 3L2 5.5L4.5 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}
function IconRedo() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <path d="M11 5.5H4.5C3.12 5.5 2 6.62 2 8C2 9.38 3.12 10.5 4.5 10.5H8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      <path d="M8.5 3L11 5.5L8.5 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}
function IconTrash() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <path d="M2 3.5H11M5 3.5V2.5H8V3.5M4.5 3.5V10.5H8.5V3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
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
    { id: "select" as const, label: t("select"), Icon: IconSelect },
    { id: "ellipse" as const, label: t("ellipse"), Icon: IconEllipse },
    { id: "underline" as const, label: t("underline"), Icon: IconUnderline },
    { id: "caret" as const, label: t("caret"), Icon: IconCaret },
  ];

  const errorTypes = [
    { value: "wrong", label: t("wrong"), cls: "text-[var(--color-wrong)] hover:bg-red-50" },
    { value: "extra", label: t("extra"), cls: "text-[var(--color-extra)] hover:bg-orange-50" },
    { value: "missing", label: t("missing"), cls: "text-[var(--color-missing)] hover:bg-blue-50" },
  ];

  const divider = <div className="h-5 w-px bg-[var(--color-border)]" />;

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2 shadow-[var(--shadow-sm)]">
      {/* Drawing tools */}
      <div className="flex gap-0.5">
        {tools.map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => onToolChange(id)}
            title={label}
            className={`flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all ${
              activeTool === id
                ? "bg-[var(--color-primary)] text-white shadow-sm"
                : "text-[var(--color-text-secondary)] hover:bg-slate-100 hover:text-[var(--color-text)]"
            }`}
          >
            <Icon />
            {label}
          </button>
        ))}
      </div>

      {divider}

      {/* Undo/Redo */}
      <div className="flex gap-0.5">
        <button
          onClick={onUndo}
          disabled={!canUndo}
          title={t("undoShortcut")}
          className="flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] transition-all hover:bg-slate-100 hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-30"
        >
          <IconUndo />
          {t("undo")}
        </button>
        <button
          onClick={onRedo}
          disabled={!canRedo}
          title={t("redoShortcut")}
          className="flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] transition-all hover:bg-slate-100 hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-30"
        >
          <IconRedo />
          {t("redo")}
        </button>
      </div>

      {/* Selection actions */}
      {selectedAnnotation !== null && (
        <>
          {divider}
          <div className="flex items-center gap-0.5">
            <span className="px-1 text-xs text-[var(--color-text-muted)]">{t("type")}</span>
            {errorTypes.map((et) => (
              <button
                key={et.value}
                onClick={() => onChangeType(et.value)}
                className={`cursor-pointer rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-all ${et.cls}`}
              >
                {et.label}
              </button>
            ))}
            <button
              onClick={onDeleteSelected}
              className="ml-0.5 flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-red-600 transition-all hover:bg-red-50"
            >
              <IconTrash />
              {tc("delete")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
