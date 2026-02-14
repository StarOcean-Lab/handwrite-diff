"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

interface OcrTextEditorProps {
  initialText: string;
  onSave: (text: string) => void;
  /** Called on every keystroke while editing (text) and when editing ends (null). */
  onTextChange?: (text: string | null) => void;
  disabled?: boolean;
}

export default function OcrTextEditor({
  initialText,
  onSave,
  onTextChange,
  disabled = false,
}: OcrTextEditorProps) {
  const t = useTranslations("ocrEditor");
  const tc = useTranslations("common");

  const [text, setText] = useState(initialText);
  const [isEditing, setIsEditing] = useState(false);

  const startEditing = () => {
    setIsEditing(true);
    onTextChange?.(text);
  };

  const handleChange = (value: string) => {
    setText(value);
    onTextChange?.(value);
  };

  const handleSave = () => {
    onSave(text);
    setIsEditing(false);
  };

  const handleCancel = () => {
    setText(initialText);
    setIsEditing(false);
    onTextChange?.(null);
  };

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium">{t("title")}</h3>
        {!isEditing ? (
          <button
            onClick={startEditing}
            disabled={disabled}
            className="text-xs text-[var(--color-primary)] hover:underline disabled:opacity-50"
          >
            {tc("edit")}
          </button>
        ) : (
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              className="rounded bg-[var(--color-primary)] px-2 py-1 text-xs text-white hover:bg-[var(--color-primary-hover)]"
            >
              {tc("save")}
            </button>
            <button
              onClick={handleCancel}
              className="rounded border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-gray-50"
            >
              {tc("cancel")}
            </button>
          </div>
        )}
      </div>
      {isEditing ? (
        <textarea
          value={text}
          onChange={(e) => handleChange(e.target.value)}
          className="w-full rounded-lg border border-[var(--color-border)] p-3 text-sm focus:border-[var(--color-primary)] focus:outline-none"
          rows={4}
        />
      ) : (
        <div className="rounded-lg bg-gray-50 p-3 text-sm whitespace-pre-wrap">
          {text || <span className="text-[var(--color-text-secondary)]">{t("noText")}</span>}
        </div>
      )}
    </div>
  );
}
