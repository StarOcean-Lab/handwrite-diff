/**
 * Client-side word-level diff engine.
 *
 * Mirrors backend/app/services/diff_engine.py — LCS-based opcode
 * generation producing the same DiffOp structure so DiffDisplay
 * can render results identically whether they come from the server
 * or are computed locally during live editing.
 */

export interface DiffOp {
  diff_type: "correct" | "wrong" | "extra" | "missing";
  ocr_index: number | null;
  ref_index: number | null;
  ocr_word: string | null;
  reference_word: string | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Normalize a word for comparison: lowercase + strip edge non-word chars. */
function normalize(word: string): string {
  return word.toLowerCase().replace(/^[^\w]+|[^\w]+$/g, "");
}

/** Strip edge punctuation for storage/display, preserving original case.
 *  Applied to every DiffOp word field so UI and annotations are punctuation-free. */
function stripDisplay(word: string | null): string | null {
  if (word === null) return null;
  const stripped = word.replace(/^[^\w]+|[^\w]+$/g, "");
  return stripped !== "" ? stripped : word;
}

type Opcode = [
  tag: "equal" | "replace" | "delete" | "insert",
  i1: number,
  i2: number,
  j1: number,
  j2: number,
];

/**
 * Compute LCS-based opcodes between two string arrays.
 *
 * Produces output equivalent to Python's
 * `difflib.SequenceMatcher.get_opcodes()`.
 */
function getOpcodes(a: string[], b: string[]): Opcode[] {
  const m = a.length;
  const n = b.length;

  // DP table — dp[i][j] = LCS length of a[0..i-1] and b[0..j-1]
  const dp: number[][] = [];
  for (let i = 0; i <= m; i++) {
    dp[i] = new Array(n + 1).fill(0);
  }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find matching index pairs
  const matches: [number, number][] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      matches.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  matches.reverse();

  // Group consecutive matches into blocks
  const blocks: { startA: number; startB: number; size: number }[] = [];
  for (const [ma, mb] of matches) {
    const last = blocks[blocks.length - 1];
    if (
      last &&
      ma === last.startA + last.size &&
      mb === last.startB + last.size
    ) {
      last.size++;
    } else {
      blocks.push({ startA: ma, startB: mb, size: 1 });
    }
  }
  // Sentinel block marks the end of both sequences
  blocks.push({ startA: m, startB: n, size: 0 });

  // Convert blocks → opcodes
  const opcodes: Opcode[] = [];
  let ai = 0;
  let bi = 0;
  for (const block of blocks) {
    if (ai < block.startA || bi < block.startB) {
      if (ai < block.startA && bi < block.startB) {
        opcodes.push(["replace", ai, block.startA, bi, block.startB]);
      } else if (ai < block.startA) {
        opcodes.push(["delete", ai, block.startA, bi, bi]);
      } else {
        opcodes.push(["insert", ai, ai, bi, block.startB]);
      }
    }
    if (block.size > 0) {
      opcodes.push([
        "equal",
        block.startA,
        block.startA + block.size,
        block.startB,
        block.startB + block.size,
      ]);
    }
    ai = block.startA + block.size;
    bi = block.startB + block.size;
  }

  return opcodes;
}

// ---------------------------------------------------------------------------
// Contraction equivalence tables
// ---------------------------------------------------------------------------

/**
 * Maps a normalized contraction to its possible expansions.
 * Ambiguous contractions (e.g. "it's" = "it is" or "it has") have multiple entries.
 */
const CONTRACTIONS: Record<string, string[][]> = {
  // subject + will
  "i'll": [["i", "will"]],
  "you'll": [["you", "will"]],
  "he'll": [["he", "will"]],
  "she'll": [["she", "will"]],
  "it'll": [["it", "will"]],
  "we'll": [["we", "will"]],
  "they'll": [["they", "will"]],
  // subject + am/are
  "i'm": [["i", "am"]],
  "you're": [["you", "are"]],
  "we're": [["we", "are"]],
  "they're": [["they", "are"]],
  // subject + is/has (ambiguous)
  "it's": [["it", "is"], ["it", "has"]],
  "he's": [["he", "is"], ["he", "has"]],
  "she's": [["she", "is"], ["she", "has"]],
  "that's": [["that", "is"], ["that", "has"]],
  "there's": [["there", "is"], ["there", "has"]],
  "here's": [["here", "is"], ["here", "has"]],
  "what's": [["what", "is"], ["what", "has"]],
  "who's": [["who", "is"], ["who", "has"]],
  // subject + have
  "i've": [["i", "have"]],
  "you've": [["you", "have"]],
  "we've": [["we", "have"]],
  "they've": [["they", "have"]],
  // subject + would/had (ambiguous)
  "i'd": [["i", "would"], ["i", "had"]],
  "you'd": [["you", "would"], ["you", "had"]],
  "he'd": [["he", "would"], ["he", "had"]],
  "she'd": [["she", "would"], ["she", "had"]],
  "we'd": [["we", "would"], ["we", "had"]],
  "they'd": [["they", "would"], ["they", "had"]],
  // negations
  "don't": [["do", "not"]],
  "doesn't": [["does", "not"]],
  "didn't": [["did", "not"]],
  "can't": [["cannot"], ["can", "not"]],
  "couldn't": [["could", "not"]],
  "won't": [["will", "not"]],
  "wouldn't": [["would", "not"]],
  "shouldn't": [["should", "not"]],
  "isn't": [["is", "not"]],
  "aren't": [["are", "not"]],
  "wasn't": [["was", "not"]],
  "weren't": [["were", "not"]],
  "hasn't": [["has", "not"]],
  "haven't": [["have", "not"]],
  "hadn't": [["had", "not"]],
  // special
  "let's": [["let", "us"]],
  cannot: [["can", "not"]],
};

/** Return all possible expansions of a normalized word. */
function expandNormalized(normWord: string): string[][] {
  if (normWord in CONTRACTIONS) {
    return CONTRACTIONS[normWord];
  }
  return [[normWord]];
}

/** Cartesian product of all possible expansions for a word sequence. */
function allExpansions(normWords: string[]): string[][] {
  const perWord = normWords.map(expandNormalized);
  // Cartesian product with flattening
  let results: string[][] = [[]];
  for (const options of perWord) {
    const next: string[][] = [];
    for (const prev of results) {
      for (const option of options) {
        next.push([...prev, ...option]);
      }
    }
    results = next;
  }
  return results;
}

/** Check if two normalized word sequences are equivalent via contractions. */
function areContractionEquivalent(
  normA: string[],
  normB: string[],
): boolean {
  if (normA.length === normB.length && normA.every((w, i) => w === normB[i])) {
    return true;
  }
  const expansionsA = allExpansions(normA);
  const expansionsB = new Set(allExpansions(normB).map((e) => e.join("\0")));
  return expansionsA.some((ea) => expansionsB.has(ea.join("\0")));
}

/**
 * Post-process diff ops to fix contraction equivalences.
 *
 * Scans for three patterns:
 *   P0: Single WRONG where the two words are directly equivalent contractions.
 *   P1: WRONG + following (WRONG|MISSING) — OCR word is a contraction whose
 *       expansion spans multiple ref words in subsequent ops.
 *   P2: WRONG + following (WRONG|EXTRA) — Ref word is a contraction whose
 *       expansion spans multiple OCR words in subsequent ops.
 *
 * When a WRONG op is consumed for its ref/OCR word during P1/P2 matching,
 * the released counterpart is re-paired with available MISSING/EXTRA ops.
 */
function fixContractions(
  ops: DiffOp[],
  ocrWords: string[],
  refWords: string[],
): DiffOp[] {
  const normOcr = ocrWords.map(normalize);
  const normRef = refWords.map(normalize);

  const result: DiffOp[] = [];
  let i = 0;
  while (i < ops.length) {
    const op = ops[i];

    if (op.diff_type !== "wrong") {
      result.push(op);
      i += 1;
      continue;
    }

    const na = normOcr[op.ocr_index!];
    const nb = normRef[op.ref_index!];

    // P0: direct contraction equivalence (e.g. can't ↔ cannot)
    if (areContractionEquivalent([na], [nb])) {
      result.push({
        diff_type: "correct",
        ocr_index: op.ocr_index,
        ref_index: op.ref_index,
        ocr_word: op.ocr_word,
        reference_word: op.reference_word,
      });
      i += 1;
      continue;
    }

    // Collect the run of consecutive non-CORRECT ops after this one
    let runEnd = i + 1;
    while (runEnd < ops.length && ops[runEnd].diff_type !== "correct") {
      runEnd++;
    }
    const run = ops.slice(i + 1, runEnd);

    // P1: OCR word is a contraction, ref words spread across following ops
    if (na in CONTRACTIONS && run.length > 0) {
      // Collect ops from run that carry a ref_index (WRONG or MISSING)
      const refBearing: [number, DiffOp][] = [];
      for (let k = 0; k < run.length; k++) {
        if (run[k].ref_index !== null) {
          refBearing.push([k, run[k]]);
        }
      }

      let matchedP1 = false;
      for (let take = 1; take <= refBearing.length; take++) {
        const refNorms = [nb];
        for (let t = 0; t < take; t++) {
          refNorms.push(normRef[refBearing[t][1].ref_index!]);
        }

        if (!areContractionEquivalent([na], refNorms)) continue;

        // Match found — build CORRECT op
        const consumedRunIndices = new Set(
          refBearing.slice(0, take).map(([k]) => k),
        );
        const mergedRef = [op.reference_word || ""];
        const releasedOcr: DiffOp[] = [];
        for (let t = 0; t < take; t++) {
          const rbOp = refBearing[t][1];
          mergedRef.push(rbOp.reference_word || "");
          if (rbOp.diff_type === "wrong") {
            releasedOcr.push(rbOp);
          }
        }

        result.push({
          diff_type: "correct",
          ocr_index: op.ocr_index,
          ref_index: op.ref_index,
          ocr_word: op.ocr_word,
          reference_word: mergedRef.join(" "),
        });

        // Non-consumed ops from the run
        const remaining = run.filter((_, k) => !consumedRunIndices.has(k));

        // Re-pair released OCR words with MISSING ops
        const missingUsed = new Set<number>();
        for (const roc of releasedOcr) {
          let paired = false;
          for (let ri = 0; ri < remaining.length; ri++) {
            if (!missingUsed.has(ri) && remaining[ri].diff_type === "missing") {
              result.push({
                diff_type: "wrong",
                ocr_index: roc.ocr_index,
                ref_index: remaining[ri].ref_index,
                ocr_word: ocrWords[roc.ocr_index!],
                reference_word: remaining[ri].reference_word,
              });
              missingUsed.add(ri);
              paired = true;
              break;
            }
          }
          if (!paired) {
            result.push({
              diff_type: "extra",
              ocr_index: roc.ocr_index,
              ref_index: null,
              ocr_word: ocrWords[roc.ocr_index!],
              reference_word: null,
            });
          }
        }

        // Emit remaining non-consumed, non-paired ops
        for (let ri = 0; ri < remaining.length; ri++) {
          if (!missingUsed.has(ri)) {
            result.push(remaining[ri]);
          }
        }

        i = runEnd;
        matchedP1 = true;
        break;
      }
      if (matchedP1) continue;
    }

    // P2: Ref word is a contraction, OCR words spread across following ops
    if (nb in CONTRACTIONS && run.length > 0) {
      // Collect ops from run that carry an ocr_index (WRONG or EXTRA)
      const ocrBearing: [number, DiffOp][] = [];
      for (let k = 0; k < run.length; k++) {
        if (run[k].ocr_index !== null) {
          ocrBearing.push([k, run[k]]);
        }
      }

      let matchedP2 = false;
      for (let take = 1; take <= ocrBearing.length; take++) {
        const ocrNorms = [na];
        for (let t = 0; t < take; t++) {
          ocrNorms.push(normOcr[ocrBearing[t][1].ocr_index!]);
        }

        if (!areContractionEquivalent(ocrNorms, [nb])) continue;

        // Match found — build CORRECT op
        const consumedRunIndices = new Set(
          ocrBearing.slice(0, take).map(([k]) => k),
        );
        const mergedOcr = [op.ocr_word || ""];
        const releasedRef: DiffOp[] = [];
        for (let t = 0; t < take; t++) {
          const obOp = ocrBearing[t][1];
          mergedOcr.push(obOp.ocr_word || "");
          if (obOp.diff_type === "wrong") {
            releasedRef.push(obOp);
          }
        }

        result.push({
          diff_type: "correct",
          ocr_index: op.ocr_index,
          ref_index: op.ref_index,
          ocr_word: mergedOcr.join(" "),
          reference_word: op.reference_word,
        });

        // Non-consumed ops from the run
        const remaining = run.filter((_, k) => !consumedRunIndices.has(k));

        // Re-pair released ref words with EXTRA ops
        const extraUsed = new Set<number>();
        for (const rref of releasedRef) {
          let paired = false;
          for (let ri = 0; ri < remaining.length; ri++) {
            if (!extraUsed.has(ri) && remaining[ri].diff_type === "extra") {
              result.push({
                diff_type: "wrong",
                ocr_index: remaining[ri].ocr_index,
                ref_index: rref.ref_index,
                ocr_word: remaining[ri].ocr_word,
                reference_word: refWords[rref.ref_index!],
              });
              extraUsed.add(ri);
              paired = true;
              break;
            }
          }
          if (!paired) {
            result.push({
              diff_type: "missing",
              ocr_index: null,
              ref_index: rref.ref_index,
              ocr_word: null,
              reference_word: refWords[rref.ref_index!],
            });
          }
        }

        // Emit remaining non-consumed, non-paired ops
        for (let ri = 0; ri < remaining.length; ri++) {
          if (!extraUsed.has(ri)) {
            result.push(remaining[ri]);
          }
        }

        i = runEnd;
        matchedP2 = true;
        break;
      }
      if (matchedP2) continue;
    }

    // No pattern matched — keep the op as-is
    result.push(op);
    i += 1;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute word-level diff between OCR output and reference text.
 *
 * Both inputs are raw word arrays — normalization (lowercase, strip
 * punctuation) is applied internally before comparison, matching
 * the backend behaviour.
 */
export function computeWordDiff(
  ocrWords: string[],
  referenceWords: string[],
): DiffOp[] {
  const normOcr = ocrWords.map(normalize);
  const normRef = referenceWords.map(normalize);

  const opcodes = getOpcodes(normOcr, normRef);
  const ops: DiffOp[] = [];

  for (const [tag, i1, i2, j1, j2] of opcodes) {
    if (tag === "equal") {
      for (let k = 0; k < i2 - i1; k++) {
        ops.push({
          diff_type: "correct",
          ocr_index: i1 + k,
          ref_index: j1 + k,
          ocr_word: ocrWords[i1 + k],
          reference_word: referenceWords[j1 + k],
        });
      }
    } else if (tag === "replace") {
      const ocrLen = i2 - i1;
      const refLen = j2 - j1;
      const maxLen = Math.max(ocrLen, refLen);
      for (let k = 0; k < maxLen; k++) {
        if (k < ocrLen && k < refLen) {
          ops.push({
            diff_type: "wrong",
            ocr_index: i1 + k,
            ref_index: j1 + k,
            ocr_word: ocrWords[i1 + k],
            reference_word: referenceWords[j1 + k],
          });
        } else if (k < ocrLen) {
          ops.push({
            diff_type: "extra",
            ocr_index: i1 + k,
            ref_index: null,
            ocr_word: ocrWords[i1 + k],
            reference_word: null,
          });
        } else {
          ops.push({
            diff_type: "missing",
            ocr_index: null,
            ref_index: j1 + k,
            ocr_word: null,
            reference_word: referenceWords[j1 + k],
          });
        }
      }
    } else if (tag === "delete") {
      for (let idx = i1; idx < i2; idx++) {
        ops.push({
          diff_type: "extra",
          ocr_index: idx,
          ref_index: null,
          ocr_word: ocrWords[idx],
          reference_word: null,
        });
      }
    } else if (tag === "insert") {
      for (let idx = j1; idx < j2; idx++) {
        ops.push({
          diff_type: "missing",
          ocr_index: null,
          ref_index: idx,
          ocr_word: null,
          reference_word: referenceWords[idx],
        });
      }
    }
  }

  const rawOps = fixContractions(ops, ocrWords, referenceWords);
  // Strip edge punctuation from all word fields — mirrors backend _strip_display().
  return rawOps.map((op) => ({
    ...op,
    ocr_word: stripDisplay(op.ocr_word),
    reference_word: stripDisplay(op.reference_word),
  }));
}
