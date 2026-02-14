"use client";

import { useTranslations } from "next-intl";

interface DiffDisplayProps {
  ocrWords: string[];
  referenceWords: string[];
  diffOps: Array<{
    diff_type: string;
    ocr_index: number | null;
    ref_index: number | null;
    ocr_word: string | null;
    reference_word: string | null;
  }>;
}

const TYPE_STYLES: Record<string, string> = {
  correct: "text-[var(--color-success)]",
  wrong: "text-[var(--color-wrong)] font-bold",
  extra: "text-[var(--color-extra)] line-through",
  missing: "text-[var(--color-missing)] font-bold",
};

const TYPE_ICONS: Record<string, string> = {
  correct: "✓",
  wrong: "✗",
  extra: "−",
  missing: "+",
};

export default function DiffDisplay({ diffOps }: DiffDisplayProps) {
  const t = useTranslations("imageReview");

  if (!diffOps || diffOps.length === 0) {
    return (
      <p className="text-sm text-[var(--color-text-secondary)]">
        {t("noDiffData")}
      </p>
    );
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {diffOps.map((op, i) => {
        const style = TYPE_STYLES[op.diff_type] || "";
        const icon = TYPE_ICONS[op.diff_type] || "";
        const display =
          op.diff_type === "missing"
            ? `^[${op.reference_word}]`
            : op.diff_type === "wrong"
              ? `${op.ocr_word}→${op.reference_word}`
              : (op.ocr_word ?? op.reference_word ?? "");

        return (
          <span
            key={i}
            className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-sm ${style}`}
            title={`${op.diff_type}: OCR="${op.ocr_word}" REF="${op.reference_word}"`}
          >
            <span className="text-xs">{icon}</span>
            {display}
          </span>
        );
      })}
    </div>
  );
}
