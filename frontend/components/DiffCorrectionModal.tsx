"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";

interface DiffOp {
  diff_type: string;
  ocr_index: number | null;
  ref_index: number | null;
  ocr_word: string | null;
  reference_word: string | null;
}

export type CorrectionAction =
  | { type: "merge"; newWord: string }
  | { type: "modify"; newWord: string }
  | { type: "retype"; newWord: string }
  | { type: "delete" }
  | { type: "accept" }
  | { type: "ignore" };

interface DiffCorrectionModalProps {
  diffOps: DiffOp[];
  onClose: () => void;
  onApply: (action: CorrectionAction) => void;
}

const DIFF_TYPE_COLORS: Record<string, string> = {
  wrong: "bg-red-100 text-red-700",
  extra: "bg-orange-100 text-orange-700",
  missing: "bg-blue-100 text-blue-700",
  correct: "bg-green-100 text-green-700",
};

/** Available actions per diff_type (single-word mode) */
const ACTIONS_BY_TYPE: Record<string, string[]> = {
  wrong: ["modify", "accept", "ignore"],
  extra: ["retype", "accept", "ignore"],
  missing: ["modify", "accept", "ignore"],
  correct: ["modify", "accept"],
};

/** Available actions in multi-word merge mode */
const MERGE_ACTIONS = ["merge", "delete", "accept", "ignore"];

export default function DiffCorrectionModal({
  diffOps,
  onClose,
  onApply,
}: DiffCorrectionModalProps) {
  const t = useTranslations("imageReview.correctionModal");

  const isMulti = diffOps.length > 1;
  const singleOp = diffOps[0];

  const [selectedAction, setSelectedAction] = useState<string | null>(null);

  // Pre-fill newWord:
  // - Multi (merge): join OCR words as the source the user will correct FROM
  // - Single (modify/retype): use reference_word; for extra (retype) start empty
  const defaultNewWord = useMemo(() => {
    if (isMulti) {
      const ocrWords = diffOps
        .map((op) => op.ocr_word)
        .filter((w): w is string => w !== null);
      return ocrWords.join(" ");
    }
    // extra type uses retype: no reference_word, start blank
    if (singleOp?.diff_type === "extra") return "";
    return singleOp?.reference_word ?? singleOp?.ocr_word ?? "";
  }, [diffOps, isMulti, singleOp]);

  const [newWord, setNewWord] = useState(defaultNewWord);

  // Sync when diffOps change
  useEffect(() => {
    setNewWord(defaultNewWord);
    setSelectedAction(null);
  }, [defaultNewWord]);

  const availableActions = isMulti
    ? MERGE_ACTIONS
    : ACTIONS_BY_TYPE[singleOp?.diff_type ?? "correct"] ?? ["accept"];

  const handleApply = () => {
    if (!selectedAction) return;

    switch (selectedAction) {
      case "merge":
        onApply({ type: "merge", newWord: newWord.trim() });
        break;
      case "modify":
        onApply({ type: "modify", newWord: newWord.trim() });
        break;
      case "retype":
        onApply({ type: "retype", newWord: newWord.trim() });
        break;
      case "delete":
        onApply({ type: "delete" });
        break;
      case "accept":
        onApply({ type: "accept" });
        break;
      case "ignore":
        onApply({ type: "ignore" });
        break;
    }
  };

  const actionLabels: Record<string, string> = {
    merge: t("merge"),
    modify: t("modify"),
    retype: t("retype"),
    delete: t("delete"),
    accept: t("accept"),
    ignore: t("ignore"),
  };

  const actionStyles: Record<string, string> = {
    merge: "border-purple-300 bg-purple-50 text-purple-700 hover:bg-purple-100",
    modify: "border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100",
    retype: "border-red-300 bg-red-50 text-red-700 hover:bg-red-100",
    delete: "border-red-300 bg-red-50 text-red-700 hover:bg-red-100",
    accept: "border-green-300 bg-green-50 text-green-700 hover:bg-green-100",
    ignore: "border-gray-300 bg-gray-50 text-gray-700 hover:bg-gray-100",
  };

  const showInput = selectedAction === "modify" || selectedAction === "merge" || selectedAction === "retype";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Title */}
        <h3 className="mb-4 text-base font-semibold text-[var(--color-text)]">
          {isMulti ? t("mergeTitle") : t("title")}
        </h3>

        {/* Word info */}
        <div className="mb-4 space-y-2 rounded-xl bg-slate-50 p-3 text-sm">
          {isMulti ? (
            /* Multi-word mode: list all selected words */
            <>
              <div className="mb-1 text-xs font-medium text-[var(--color-text-secondary)]">
                {t("selectedWords")}
              </div>
              {diffOps.map((op, i) => {
                const diffTypeLabel = t(
                  `type${op.diff_type.charAt(0).toUpperCase() + op.diff_type.slice(1)}` as Parameters<typeof t>[0],
                );
                return (
                  <div key={i} className="flex items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${DIFF_TYPE_COLORS[op.diff_type] ?? ""}`}>
                      {diffTypeLabel}
                    </span>
                    {op.ocr_word !== null && (
                      <span className="font-mono font-medium text-[var(--color-text)]">
                        {op.ocr_word}
                      </span>
                    )}
                    {op.reference_word !== null && (
                      <>
                        <span className="text-[var(--color-text-muted)]">→</span>
                        <span className="font-mono text-[var(--color-text-secondary)]">
                          {op.reference_word}
                        </span>
                      </>
                    )}
                  </div>
                );
              })}
              <div className="mt-1 text-xs text-[var(--color-text-muted)]">
                {t("mergeHint")}
              </div>
            </>
          ) : (
            /* Single-word mode: existing layout */
            <>
              <div className="flex items-center justify-between">
                <span className="text-[var(--color-text-secondary)]">{t("diffType")}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${DIFF_TYPE_COLORS[singleOp.diff_type] ?? ""}`}>
                  {t(`type${singleOp.diff_type.charAt(0).toUpperCase() + singleOp.diff_type.slice(1)}` as Parameters<typeof t>[0])}
                </span>
              </div>
              {singleOp.ocr_word !== null && (
                <div className="flex items-center justify-between">
                  <span className="text-[var(--color-text-secondary)]">{t("ocrWord")}</span>
                  <span className="font-mono font-medium text-[var(--color-text)]">{singleOp.ocr_word}</span>
                </div>
              )}
              {singleOp.reference_word !== null && (
                <div className="flex items-center justify-between">
                  <span className="text-[var(--color-text-secondary)]">{t("refWord")}</span>
                  <span className="font-mono font-medium text-[var(--color-text)]">{singleOp.reference_word}</span>
                </div>
              )}
            </>
          )}
        </div>

        {/* Action buttons */}
        <div className="mb-4 flex flex-wrap gap-2">
          {availableActions.map((action) => (
            <button
              key={action}
              onClick={() => setSelectedAction(action)}
              className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-all ${
                actionStyles[action] ?? ""
              } ${selectedAction === action ? "ring-2 ring-[var(--color-primary)] ring-offset-1" : ""}`}
            >
              {actionLabels[action]}
            </button>
          ))}
        </div>

        {/* Input for modify / merge */}
        {showInput && (
          <div className="mb-4">
            <label className="mb-1 block text-sm text-[var(--color-text-secondary)]">
              {t("newWord")}
            </label>
            <input
              type="text"
              value={newWord}
              onChange={(e) => setNewWord(e.target.value)}
              className="w-full rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm focus:border-[var(--color-primary)] focus:outline-none"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (newWord.trim()) handleApply();
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  onClose();
                }
              }}
            />
          </div>
        )}

        {/* Footer */}
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-xl border border-[var(--color-border)] px-4 py-2 text-sm font-medium text-[var(--color-text-secondary)] transition-all hover:bg-slate-50"
          >
            {t("cancel")}
          </button>
          <button
            onClick={handleApply}
            disabled={!selectedAction || (showInput && !newWord.trim())}
            className="rounded-xl px-4 py-2 text-sm font-semibold text-white transition-all hover:shadow-md disabled:opacity-50"
            style={{ background: "linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)" }}
          >
            {t("apply")}
          </button>
        </div>
      </div>
    </div>
  );
}
