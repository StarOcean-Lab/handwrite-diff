"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

interface DiffOp {
  diff_type: string;
  ocr_index: number | null;
  ref_index: number | null;
  ocr_word: string | null;
  reference_word: string | null;
  ocr_confidence?: number | null;
}

interface DiffDisplayProps {
  ocrWords: string[];
  referenceWords: string[];
  diffOps: DiffOp[];
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

const LOW_CONFIDENCE_THRESHOLD = 0.7;

/** Strip leading/trailing punctuation from a word for display purposes.
 *  DiffOp words are already stripped by diff_engine / lib/diff.ts, so this
 *  is a no-op in practice but acts as a safety net for any edge cases. */
function stripEdgePunct(word: string): string {
  return word.replace(/^[^\w]+|[^\w]+$/g, "");
}

function displayWord(word: string | null): string {
  if (word === null) return "";
  return stripEdgePunct(word) || word;
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

interface TooltipProps {
  text: string;
  children: React.ReactNode;
  className?: string;
}

function Tooltip({ text, children, className = "" }: TooltipProps) {
  const [visible, setVisible] = useState(false);

  return (
    <span
      className={`relative inline-flex items-center ${className}`}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
    >
      {children}
      {visible && (
        <span
          role="tooltip"
          className={
            "pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 " +
            "-translate-x-1/2 whitespace-nowrap rounded-md " +
            "bg-gray-900 px-2.5 py-1.5 text-xs font-medium text-white " +
            "shadow-lg ring-1 ring-white/10"
          }
        >
          {text}
          {/* Arrow */}
          <span
            className={
              "absolute left-1/2 top-full -translate-x-1/2 " +
              "border-4 border-transparent border-t-gray-900"
            }
          />
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// DiffDisplay
// ---------------------------------------------------------------------------

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
            ? `^[${displayWord(op.reference_word)}]`
            : op.diff_type === "wrong"
              ? `${displayWord(op.ocr_word)}→${displayWord(op.reference_word)}`
              : displayWord(op.ocr_word ?? op.reference_word);

        const isLowConfidence =
          op.diff_type === "correct" &&
          op.ocr_confidence != null &&
          op.ocr_confidence < LOW_CONFIDENCE_THRESHOLD;

        const confidencePct =
          op.ocr_confidence != null ? Math.round(op.ocr_confidence * 100) : null;

        const lowConfidenceClass = isLowConfidence
          ? "border-b-2 border-dashed border-amber-400"
          : "";

        const tooltipText = isLowConfidence
          ? t("lowConfidenceHint", { pct: confidencePct ?? 0 })
          : `${op.diff_type}: OCR="${op.ocr_word}" REF="${op.reference_word}"`;

        return (
          <Tooltip key={i} text={tooltipText}>
            <span
              className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-sm ${style} ${lowConfidenceClass}`}
            >
              <span className="text-xs">{icon}</span>
              {display}
              {isLowConfidence && (
                <span className="ml-0.5 text-xs text-amber-500" aria-hidden>⚠</span>
              )}
            </span>
          </Tooltip>
        );
      })}
    </div>
  );
}
