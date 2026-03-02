/**
 * Pure functions extracted from the image review page.
 * Kept separate so they can be unit-tested without a React environment.
 */

import type { Annotation } from "./api";

export interface RawDiffOp {
  diff_type: string;
  ocr_index: number | null;
  ref_index: number | null;
  ocr_word: string | null;
  reference_word: string | null;
  ocr_confidence?: number | null;
}

export interface CorrectionEntry {
  type: "merge" | "modify" | "retype";
  newWord: string;
  mergedOcrWords: string;
  hidden: boolean;
}

/** Minimal annotation shape needed to rebuild correction entries. */
export interface AnnotationForRebuild {
  word_index: number | null;
  ocr_word: string | null;
  reference_word: string | null;
  error_type: string;
  is_user_corrected: boolean;
}

/**
 * Rebuild correctedDiffEntries from annotations + diff_result after
 * regeneration or initial page load, so merge groups survive round-trips.
 *
 * Extracted as a pure function so it can be unit-tested independently of React.
 */
export function rebuildCorrectedEntries(
  diffResult: RawDiffOp[] | null | undefined,
  annotations: AnnotationForRebuild[] | null | undefined,
): Map<number, CorrectionEntry> {
  const entries = new Map<number, CorrectionEntry>();
  if (!diffResult || !annotations) return entries;

  const corrected = annotations.filter((a) => a.is_user_corrected);

  for (const leader of corrected) {
    // Detect merge groups: leader annotation has ocr_word containing a space
    // and is not marked as "correct" (a same-word merge would have error_type correct)
    if (!leader.ocr_word?.includes(" ") || leader.error_type === "correct") continue;

    const diffIdx = diffResult.findIndex((op) => op.ocr_index === leader.word_index);
    if (diffIdx === -1) continue;

    entries.set(diffIdx, {
      type: "merge",
      newWord: leader.reference_word ?? "",
      mergedOcrWords: leader.ocr_word ?? "",
      hidden: false,
    });

    // Mark hidden members by walking word_index offsets
    const wordCount = leader.ocr_word.split(" ").length;
    if (leader.word_index !== null) {
      for (let off = 1; off < wordCount; off++) {
        const memberIdx = leader.word_index + off;
        const memberDiffIdx = diffResult.findIndex((op) => op.ocr_index === memberIdx);
        if (memberDiffIdx !== -1) {
          entries.set(memberDiffIdx, { type: "merge", newWord: "", mergedOcrWords: "", hidden: true });
        }
      }
    }
  }
  return entries;
}

export function computeDisplayDiffOps(
  rawOps: RawDiffOp[],
  ignoredIndices: Set<number>,
  correctedEntries: Map<number, CorrectionEntry>,
): RawDiffOp[] {
  if (ignoredIndices.size === 0 && correctedEntries.size === 0) return rawOps;

  // ── Re-pairing pass ──────────────────────────────────────────────────────
  // When a merge hides a diff op whose reference_word differs from its OCR
  // word (e.g. "foods→I've" absorbed into "great foods→grapefruit"), that
  // reference word becomes "orphaned". The old behavior surfaced it as a
  // spurious +^[I've] MISSING while the next -I stayed as EXTRA — producing
  // two separate entries for what should be a single × I→I've WRONG.
  //
  // Fix: for each such orphaned reference word, scan forward in the diff for
  // the next available EXTRA op (stopping at alignment anchors) and re-pair
  // them: the EXTRA becomes WRONG with the orphaned ref, and the hidden
  // member is suppressed silently (corrected_hidden) instead of shown as
  // MISSING.
  const repairedExtras = new Map<number, string>(); // extra op index → paired ref word
  const repairedHiddens = new Set<number>();         // hidden op indices whose ref is re-paired
  const usedExtraIndices = new Set<number>();

  for (let i = 0; i < rawOps.length; i++) {
    const entry = correctedEntries.get(i);
    if (!entry?.hidden) continue;
    const op = rawOps[i];
    if (!op.reference_word || op.reference_word === op.ocr_word) continue;

    // ── Cross-line guard ──────────────────────────────────────────────────
    // For cross-line merges the frontend overwrites the hidden member's
    // reference_word to `action.newWord` (the merge target, e.g. "grapefruit")
    // so that each word's ellipse label shows the correct answer.  After a
    // round-trip through the backend this value ends up in diff_result_json,
    // causing the re-pairing below to (incorrectly) emit "×I→grapefruit".
    //
    // Detection: if the hidden member's reference_word equals the leader's
    // newWord, it was overwritten for cross-line display purposes — the
    // leader already accounts for that reference word, so silently hide this
    // member without absorbing any subsequent EXTRA op.
    let leaderEntry: CorrectionEntry | undefined;
    for (let k = i - 1; k >= 0; k--) {
      const e = correctedEntries.get(k);
      if (e && !e.hidden) { leaderEntry = e; break; }
    }
    if (leaderEntry && leaderEntry.newWord === op.reference_word) {
      repairedHiddens.add(i); // mark as silently hidden — no EXTRA consumed
      continue;
    }
    // ─────────────────────────────────────────────────────────────────────

    // Search forward for the next available EXTRA op to absorb this orphaned ref
    for (let j = i + 1; j < rawOps.length; j++) {
      if (usedExtraIndices.has(j)) continue;
      const jEntry = correctedEntries.get(j);
      if (jEntry) continue; // skip other merge members (leaders or hidden)
      if (ignoredIndices.has(j)) continue;
      const jOp = rawOps[j];
      if (jOp.diff_type === "extra") {
        repairedExtras.set(j, op.reference_word);
        repairedHiddens.add(i);
        usedExtraIndices.add(j);
        break;
      }
      // Stop at alignment anchors — correct/missing ops mean the sequence
      // matcher has already paired everything beyond this point.
      if (jOp.diff_type === "correct" || jOp.diff_type === "missing") break;
    }
  }
  // ────────────────────────────────────────────────────────────────────────

  return rawOps.map((op, i) => {
    const entry = correctedEntries.get(i);
    if (entry) {
      if (entry.hidden) {
        if (repairedHiddens.has(i)) {
          // Orphaned ref successfully re-paired with a subsequent EXTRA → hide silently
          return { ...op, diff_type: "corrected_hidden" };
        }
        if (op.reference_word && op.reference_word !== op.ocr_word) {
          return { ...op, diff_type: "missing", ocr_index: null, ocr_word: null };
        }
        return { ...op, diff_type: "corrected_hidden" };
      }
      if (entry.type === "retype") {
        // extra → wrong: force red annotation with user-supplied reference word
        return { ...op, diff_type: "wrong", reference_word: entry.newWord };
      }
      if (entry.type === "modify") {
        const ocrNorm = (op.ocr_word ?? "").toLowerCase().trim();
        const newNorm = entry.newWord.toLowerCase().trim();
        const newDiffType = ocrNorm === newNorm ? "correct" : op.diff_type;
        return { ...op, diff_type: newDiffType, reference_word: entry.newWord };
      }
      // Merge leader: show merged OCR words → user's corrected word
      return { ...op, ocr_word: entry.mergedOcrWords, reference_word: entry.newWord };
    }

    // Re-paired EXTRA: elevate to WRONG with the orphaned reference word
    if (repairedExtras.has(i)) {
      return { ...op, diff_type: "wrong", reference_word: repairedExtras.get(i)! };
    }

    if (ignoredIndices.has(i)) {
      return { ...op, diff_type: "correct" };
    }
    return op;
  });
}

/**
 * Convert annotations to diff ops for immediate display after saving.
 *
 * This function is used when the user saves manual annotations - we want
 * to immediately show the updated diff result in the UI without waiting
 * for the backend to recalculate. The backend rediff happens asynchronously.
 *
 * @param annotations - The saved annotations (may include user corrections)
 * @param ocrWords - OCR words from the image
 * @param refWords - Reference words from the task
 * @returns Diff ops reflecting the annotation changes
 */
export function annotationsToDiffOps(
  annotations: Annotation[],
  ocrWords: { text: string }[],
  refWords: string[],
): RawDiffOp[] {
  // Create word_index -> annotation mapping
  const annotMap = new Map<number, Annotation>();
  for (const a of annotations) {
    if (a.word_index !== null && a.word_index !== undefined) {
      annotMap.set(a.word_index, a);
    }
  }

  const diffOps: RawDiffOp[] = [];

  // Process OCR words - generate diff ops based on annotations
  for (let i = 0; i < ocrWords.length; i++) {
    const annot = annotMap.get(i);
    const ocrWord = ocrWords[i]?.text ?? "";
    const refWord = refWords[i] ?? "";

    if (annot) {
      // Use annotation data (user-modified) - but if error_type is 'correct',
      // we should mark it as correct even if the words differ
      const isCorrect = annot.error_type === "correct";
      diffOps.push({
        diff_type: annot.error_type,
        ocr_index: i,
        ref_index: i,
        ocr_word: isCorrect ? ocrWord : (annot.ocr_word ?? ocrWord),
        reference_word: isCorrect ? refWord : (annot.reference_word ?? refWord),
      });
    } else {
      // No annotation - default to correct
      diffOps.push({
        diff_type: "correct",
        ocr_index: i,
        ref_index: i,
        ocr_word: ocrWord,
        reference_word: refWord,
      });
    }
  }

  // Handle annotations beyond the original OCR word count (new annotations)
  for (const [idx, annot] of annotMap) {
    if (idx >= ocrWords.length) {
      diffOps.push({
        diff_type: annot.error_type,
        ocr_index: idx,
        ref_index: idx,
        ocr_word: annot.ocr_word ?? "",
        reference_word: annot.reference_word ?? "",
      });
    }
  }

  return diffOps;
}
