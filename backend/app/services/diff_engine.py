"""Word-level diff engine.

Compares OCR-recognized words against reference words using
difflib.SequenceMatcher and outputs structured diff operations.
"""

import difflib
import re
from dataclasses import dataclass
from enum import Enum
from itertools import product


class DiffType(str, Enum):
    CORRECT = "correct"
    WRONG = "wrong"      # replace: OCR word != reference word
    MISSING = "missing"  # insert: reference has word, OCR doesn't
    EXTRA = "extra"      # delete: OCR has word, reference doesn't


@dataclass(frozen=True)
class DiffOp:
    """A single diff operation between OCR and reference text."""
    diff_type: DiffType
    ocr_index: int | None       # Index in OCR word list (None for MISSING)
    ref_index: int | None       # Index in reference word list (None for EXTRA)
    ocr_word: str | None        # The OCR word (None for MISSING)
    reference_word: str | None  # The reference word (None for EXTRA)


def _normalize(word: str) -> str:
    """Normalize a word for comparison: lowercase + strip edge punctuation."""
    return re.sub(r"^[^\w]+|[^\w]+$", "", word.lower())


# ---------------------------------------------------------------------------
# Number equivalence tables
# ---------------------------------------------------------------------------

# Maps English number words (normalized) to their integer values.
# Covers cardinal and ordinal forms for 0–90 plus hundred/thousand.
_NUMBER_WORD_TO_INT: dict[str, int] = {
    # Cardinals 0–19
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4,
    "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
    "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13,
    "fourteen": 14, "fifteen": 15, "sixteen": 16, "seventeen": 17,
    "eighteen": 18, "nineteen": 19,
    # Cardinals — tens
    "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50,
    "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90,
    # Cardinals — large units
    "hundred": 100, "thousand": 1000,
    # Ordinals 1–20
    "first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5,
    "sixth": 6, "seventh": 7, "eighth": 8, "ninth": 9, "tenth": 10,
    "eleventh": 11, "twelfth": 12, "thirteenth": 13, "fourteenth": 14,
    "fifteenth": 15, "sixteenth": 16, "seventeenth": 17, "eighteenth": 18,
    "nineteenth": 19, "twentieth": 20,
    # Ordinals — tens
    "thirtieth": 30, "fortieth": 40, "fiftieth": 50,
    "sixtieth": 60, "seventieth": 70, "eightieth": 80, "ninetieth": 90,
}

# Suffix pattern used to strip ordinal suffixes from Arabic numerals (1st, 2nd …)
_ORDINAL_SUFFIX_RE = re.compile(r"(st|nd|rd|th)$")


def _parse_as_number(norm_word: str) -> int | None:
    """Return the integer value of a normalized word if it represents a number.

    Accepts:
    - Arabic numerals: "1", "42"
    - Arabic ordinals: "1st", "2nd", "3rd", "4th"
    - English cardinal words: "one", "twenty"
    - English ordinal words: "first", "twentieth"

    Returns None if the word cannot be interpreted as a number.
    """
    # Strip ordinal suffix before trying int() so "1st" → "1"
    arabic = _ORDINAL_SUFFIX_RE.sub("", norm_word)
    try:
        return int(arabic)
    except ValueError:
        pass
    return _NUMBER_WORD_TO_INT.get(norm_word)


def _are_number_equivalent(norm_a: str, norm_b: str) -> bool:
    """Return True if two normalized words represent the same number."""
    val_a = _parse_as_number(norm_a)
    if val_a is None:
        return False
    val_b = _parse_as_number(norm_b)
    return val_b is not None and val_a == val_b


def _strip_display(word: str | None) -> str | None:
    """Strip edge punctuation for storage/display, preserving original case.

    Applied to ocr_word and reference_word in every DiffOp so that all
    downstream consumers (DB, annotated images, UI) are punctuation-free.
    Falls back to the original if stripping would produce an empty string
    (e.g. the word consists entirely of punctuation).
    """
    if word is None:
        return None
    stripped = re.sub(r"^[^\w]+|[^\w]+$", "", word)
    return stripped if stripped else word


def normalize_word_list(text: str) -> list[str]:
    """Split text into a word list, preserving original punctuation and case.

    Punctuation stripping is intentionally deferred to comparison time via
    _normalize(), so that display and annotations show the original words.
    """
    return [w for w in text.split() if w]


# ---------------------------------------------------------------------------
# Contraction equivalence tables
# ---------------------------------------------------------------------------

# Maps a normalized contraction to its possible expansions.
# Each expansion is a list of normalized words.
# Ambiguous contractions (e.g. "it's" = "it is" or "it has") have multiple entries.
CONTRACTIONS: dict[str, list[list[str]]] = {
    # subject + will
    "i'll": [["i", "will"]],
    "you'll": [["you", "will"]],
    "he'll": [["he", "will"]],
    "she'll": [["she", "will"]],
    "it'll": [["it", "will"]],
    "we'll": [["we", "will"]],
    "they'll": [["they", "will"]],
    # subject + am/are
    "i'm": [["i", "am"]],
    "you're": [["you", "are"]],
    "we're": [["we", "are"]],
    "they're": [["they", "are"]],
    # subject + is/has (ambiguous)
    "it's": [["it", "is"], ["it", "has"]],
    "he's": [["he", "is"], ["he", "has"]],
    "she's": [["she", "is"], ["she", "has"]],
    "that's": [["that", "is"], ["that", "has"]],
    "there's": [["there", "is"], ["there", "has"]],
    "here's": [["here", "is"], ["here", "has"]],
    "what's": [["what", "is"], ["what", "has"]],
    "who's": [["who", "is"], ["who", "has"]],
    # subject + have
    "i've": [["i", "have"]],
    "you've": [["you", "have"]],
    "we've": [["we", "have"]],
    "they've": [["they", "have"]],
    # subject + would/had (ambiguous)
    "i'd": [["i", "would"], ["i", "had"]],
    "you'd": [["you", "would"], ["you", "had"]],
    "he'd": [["he", "would"], ["he", "had"]],
    "she'd": [["she", "would"], ["she", "had"]],
    "we'd": [["we", "would"], ["we", "had"]],
    "they'd": [["they", "would"], ["they", "had"]],
    # negations
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
    # special
    "let's": [["let", "us"]],
    "cannot": [["can", "not"]],
}

# Build reverse map: expansion tuple -> list of contractions
_EXPANSION_TO_CONTRACTIONS: dict[tuple[str, ...], list[str]] = {}
for _cword, _expansions in CONTRACTIONS.items():
    for _exp in _expansions:
        _key = tuple(_exp)
        _EXPANSION_TO_CONTRACTIONS.setdefault(_key, []).append(_cword)


def _expand_normalized(norm_word: str) -> list[list[str]]:
    """Return all possible expansions of a normalized word.

    If the word is a known contraction, returns its expansion forms.
    Otherwise returns the word itself as a single-element list.
    """
    if norm_word in CONTRACTIONS:
        return CONTRACTIONS[norm_word]
    return [[norm_word]]


def _all_expansions(norm_words: list[str]) -> list[tuple[str, ...]]:
    """Cartesian product of all possible expansions for a word sequence."""
    per_word = [_expand_normalized(w) for w in norm_words]
    result: list[tuple[str, ...]] = []
    for combo in product(*per_word):
        # combo is a tuple of lists; flatten into a single tuple of strings
        flat: list[str] = []
        for segment in combo:
            flat.extend(segment)
        result.append(tuple(flat))
    return result


def _are_contraction_equivalent(
    norm_a: list[str], norm_b: list[str],
) -> bool:
    """Check if two normalized word sequences are equivalent via contractions."""
    if norm_a == norm_b:
        return True
    expansions_a = _all_expansions(norm_a)
    expansions_b = _all_expansions(norm_b)
    # Check if any expansion of A matches any expansion of B
    set_b = set(expansions_b)
    return any(ea in set_b for ea in expansions_a)


def _fix_contractions(
    ops: list[DiffOp],
    ocr_words: list[str],
    ref_words: list[str],
) -> list[DiffOp]:
    """Post-process diff ops to fix contraction equivalences.

    Scans for three patterns:
      P0: Single WRONG where the two words are directly equivalent contractions.
      P1: WRONG + following (WRONG|MISSING) — OCR word is a contraction whose
          expansion spans multiple ref words in subsequent ops.
      P2: WRONG + following (WRONG|EXTRA) — Ref word is a contraction whose
          expansion spans multiple OCR words in subsequent ops.

    When a WRONG op is consumed for its ref/OCR word during P1/P2 matching,
    the released counterpart is re-paired with available MISSING/EXTRA ops.
    """
    norm_ocr = [_normalize(w) for w in ocr_words]
    norm_ref = [_normalize(w) for w in ref_words]

    result: list[DiffOp] = []
    i = 0
    while i < len(ops):
        op = ops[i]

        if op.diff_type != DiffType.WRONG:
            result.append(op)
            i += 1
            continue

        assert op.ocr_index is not None and op.ref_index is not None
        na = norm_ocr[op.ocr_index]
        nb = norm_ref[op.ref_index]

        # P0: single WRONG, direct equivalence (contraction or number word ↔ digit)
        if _are_contraction_equivalent([na], [nb]) or _are_number_equivalent(na, nb):
            result.append(DiffOp(
                diff_type=DiffType.CORRECT,
                ocr_index=op.ocr_index,
                ref_index=op.ref_index,
                ocr_word=op.ocr_word,
                reference_word=op.reference_word,
            ))
            i += 1
            continue

        # Collect the run of consecutive non-CORRECT ops after this one
        run_end = i + 1
        while run_end < len(ops) and ops[run_end].diff_type != DiffType.CORRECT:
            run_end += 1
        run = ops[i + 1 : run_end]

        # P1: OCR word is a contraction, ref words spread across following ops
        if na in CONTRACTIONS and run:
            # Collect ops from run that carry a ref_index (WRONG or MISSING)
            ref_bearing = [(k, run[k]) for k in range(len(run))
                           if run[k].ref_index is not None]

            matched = False
            for take in range(1, len(ref_bearing) + 1):
                ref_norms = [nb]
                for _, rb_op in ref_bearing[:take]:
                    assert rb_op.ref_index is not None
                    ref_norms.append(norm_ref[rb_op.ref_index])

                if not _are_contraction_equivalent([na], ref_norms):
                    continue

                # Match found — build CORRECT op
                consumed_run_indices = {k for k, _ in ref_bearing[:take]}
                merged_ref = [op.reference_word or ""]
                released_ocr: list[DiffOp] = []
                for _, rb_op in ref_bearing[:take]:
                    merged_ref.append(rb_op.reference_word or "")
                    if rb_op.diff_type == DiffType.WRONG:
                        released_ocr.append(rb_op)

                result.append(DiffOp(
                    diff_type=DiffType.CORRECT,
                    ocr_index=op.ocr_index,
                    ref_index=op.ref_index,
                    ocr_word=op.ocr_word,
                    reference_word=" ".join(merged_ref),
                ))

                # Non-consumed ops from the run
                remaining = [run[k] for k in range(len(run))
                             if k not in consumed_run_indices]

                # Re-pair released OCR words (from consumed WRONGs) with MISSING ops
                missing_indices_used: set[int] = set()
                for roc in released_ocr:
                    paired = False
                    for ri, rop in enumerate(remaining):
                        if ri not in missing_indices_used and rop.diff_type == DiffType.MISSING:
                            assert roc.ocr_index is not None
                            result.append(DiffOp(
                                diff_type=DiffType.WRONG,
                                ocr_index=roc.ocr_index,
                                ref_index=rop.ref_index,
                                ocr_word=ocr_words[roc.ocr_index],
                                reference_word=rop.reference_word,
                            ))
                            missing_indices_used.add(ri)
                            paired = True
                            break
                    if not paired:
                        assert roc.ocr_index is not None
                        result.append(DiffOp(
                            diff_type=DiffType.EXTRA,
                            ocr_index=roc.ocr_index,
                            ref_index=None,
                            ocr_word=ocr_words[roc.ocr_index],
                            reference_word=None,
                        ))

                # Emit remaining non-consumed, non-paired ops
                for ri, rop in enumerate(remaining):
                    if ri not in missing_indices_used:
                        result.append(rop)

                i = run_end
                matched = True
                break

            # P1b: nb is MISSING; subsequent ref words alone match the OCR contraction.
            # Example: OCR "you're" vs ref "of you are" → MISSING "of", CORRECT "you're"↔"you are"
            if not matched and ref_bearing:
                for take in range(1, len(ref_bearing) + 1):
                    ref_norms_b = [
                        norm_ref[rb_op.ref_index]  # type: ignore[arg-type]
                        for _, rb_op in ref_bearing[:take]
                    ]
                    if not _are_contraction_equivalent([na], ref_norms_b):
                        continue

                    # nb is MISSING; bearing ref words form CORRECT with na
                    result.append(DiffOp(
                        diff_type=DiffType.MISSING,
                        ocr_index=None,
                        ref_index=op.ref_index,
                        ocr_word=None,
                        reference_word=op.reference_word,
                    ))

                    consumed_b = {k for k, _ in ref_bearing[:take]}
                    merged_ref_b = [rb_op.reference_word or "" for _, rb_op in ref_bearing[:take]]
                    released_ocr_b: list[DiffOp] = [
                        rb_op for _, rb_op in ref_bearing[:take]
                        if rb_op.diff_type == DiffType.WRONG
                    ]

                    result.append(DiffOp(
                        diff_type=DiffType.CORRECT,
                        ocr_index=op.ocr_index,
                        ref_index=ref_bearing[0][1].ref_index,
                        ocr_word=op.ocr_word,
                        reference_word=" ".join(merged_ref_b),
                    ))

                    remaining_b = [run[k] for k in range(len(run)) if k not in consumed_b]
                    missing_used_b: set[int] = set()
                    for roc in released_ocr_b:
                        paired = False
                        for ri, rop in enumerate(remaining_b):
                            if ri not in missing_used_b and rop.diff_type == DiffType.MISSING:
                                assert roc.ocr_index is not None
                                result.append(DiffOp(
                                    diff_type=DiffType.WRONG,
                                    ocr_index=roc.ocr_index,
                                    ref_index=rop.ref_index,
                                    ocr_word=ocr_words[roc.ocr_index],
                                    reference_word=rop.reference_word,
                                ))
                                missing_used_b.add(ri)
                                paired = True
                                break
                        if not paired:
                            assert roc.ocr_index is not None
                            result.append(DiffOp(
                                diff_type=DiffType.EXTRA,
                                ocr_index=roc.ocr_index,
                                ref_index=None,
                                ocr_word=ocr_words[roc.ocr_index],
                                reference_word=None,
                            ))

                    for ri, rop in enumerate(remaining_b):
                        if ri not in missing_used_b:
                            result.append(rop)

                    i = run_end
                    matched = True
                    break

            if matched:
                continue

        # P2: Ref word is a contraction, OCR words spread across following ops
        if nb in CONTRACTIONS and run:
            # Collect ops from run that carry an ocr_index (WRONG or EXTRA)
            ocr_bearing = [(k, run[k]) for k in range(len(run))
                           if run[k].ocr_index is not None]

            matched = False
            for take in range(1, len(ocr_bearing) + 1):
                ocr_norms = [na]
                for _, ob_op in ocr_bearing[:take]:
                    assert ob_op.ocr_index is not None
                    ocr_norms.append(norm_ocr[ob_op.ocr_index])

                if not _are_contraction_equivalent(ocr_norms, [nb]):
                    continue

                # Match found — build CORRECT op
                consumed_run_indices = {k for k, _ in ocr_bearing[:take]}
                merged_ocr = [op.ocr_word or ""]
                released_ref: list[DiffOp] = []
                for _, ob_op in ocr_bearing[:take]:
                    merged_ocr.append(ob_op.ocr_word or "")
                    if ob_op.diff_type == DiffType.WRONG:
                        released_ref.append(ob_op)

                result.append(DiffOp(
                    diff_type=DiffType.CORRECT,
                    ocr_index=op.ocr_index,
                    ref_index=op.ref_index,
                    ocr_word=" ".join(merged_ocr),
                    reference_word=op.reference_word,
                ))

                # Non-consumed ops from the run
                remaining = [run[k] for k in range(len(run))
                             if k not in consumed_run_indices]

                # Re-pair released ref words (from consumed WRONGs) with EXTRA ops
                extra_indices_used: set[int] = set()
                for rref in released_ref:
                    paired = False
                    for ri, rop in enumerate(remaining):
                        if ri not in extra_indices_used and rop.diff_type == DiffType.EXTRA:
                            assert rref.ref_index is not None
                            result.append(DiffOp(
                                diff_type=DiffType.WRONG,
                                ocr_index=rop.ocr_index,
                                ref_index=rref.ref_index,
                                ocr_word=rop.ocr_word,
                                reference_word=ref_words[rref.ref_index],
                            ))
                            extra_indices_used.add(ri)
                            paired = True
                            break
                    if not paired:
                        assert rref.ref_index is not None
                        result.append(DiffOp(
                            diff_type=DiffType.MISSING,
                            ocr_index=None,
                            ref_index=rref.ref_index,
                            ocr_word=None,
                            reference_word=ref_words[rref.ref_index],
                        ))

                # Emit remaining non-consumed, non-paired ops
                for ri, rop in enumerate(remaining):
                    if ri not in extra_indices_used:
                        result.append(rop)

                i = run_end
                matched = True
                break

            # P2b: na is EXTRA; subsequent OCR words alone match the ref contraction.
            # Example: OCR "of you are" vs ref "you're" → EXTRA "of", CORRECT "you are"↔"you're"
            if not matched and ocr_bearing:
                for take in range(1, len(ocr_bearing) + 1):
                    ocr_norms_b = [
                        norm_ocr[ob_op.ocr_index]  # type: ignore[arg-type]
                        for _, ob_op in ocr_bearing[:take]
                    ]
                    if not _are_contraction_equivalent(ocr_norms_b, [nb]):
                        continue

                    # na is EXTRA; bearing OCR words form CORRECT with nb
                    result.append(DiffOp(
                        diff_type=DiffType.EXTRA,
                        ocr_index=op.ocr_index,
                        ref_index=None,
                        ocr_word=op.ocr_word,
                        reference_word=None,
                    ))

                    consumed_b = {k for k, _ in ocr_bearing[:take]}
                    merged_ocr_b = [ob_op.ocr_word or "" for _, ob_op in ocr_bearing[:take]]
                    released_ref_b: list[DiffOp] = [
                        ob_op for _, ob_op in ocr_bearing[:take]
                        if ob_op.diff_type == DiffType.WRONG
                    ]

                    result.append(DiffOp(
                        diff_type=DiffType.CORRECT,
                        ocr_index=ocr_bearing[0][1].ocr_index,
                        ref_index=op.ref_index,
                        ocr_word=" ".join(merged_ocr_b),
                        reference_word=op.reference_word,
                    ))

                    remaining_b = [run[k] for k in range(len(run)) if k not in consumed_b]
                    extra_used_b: set[int] = set()
                    for rref in released_ref_b:
                        paired = False
                        for ri, rop in enumerate(remaining_b):
                            if ri not in extra_used_b and rop.diff_type == DiffType.EXTRA:
                                assert rref.ref_index is not None
                                result.append(DiffOp(
                                    diff_type=DiffType.WRONG,
                                    ocr_index=rop.ocr_index,
                                    ref_index=rref.ref_index,
                                    ocr_word=rop.ocr_word,
                                    reference_word=ref_words[rref.ref_index],
                                ))
                                extra_used_b.add(ri)
                                paired = True
                                break
                        if not paired:
                            assert rref.ref_index is not None
                            result.append(DiffOp(
                                diff_type=DiffType.MISSING,
                                ocr_index=None,
                                ref_index=rref.ref_index,
                                ocr_word=None,
                                reference_word=ref_words[rref.ref_index],
                            ))

                    for ri, rop in enumerate(remaining_b):
                        if ri not in extra_used_b:
                            result.append(rop)

                    i = run_end
                    matched = True
                    break

            if matched:
                continue

        # No pattern matched — keep the op as-is
        result.append(op)
        i += 1

    return result


def compute_word_diff(
    ocr_words: list[str],
    reference_words: list[str],
) -> list[DiffOp]:
    """Compute word-level diff between OCR output and reference text.

    Uses difflib.SequenceMatcher on normalized words.

    Args:
        ocr_words: Words recognized by OCR.
        reference_words: Words from the reference text.

    Returns:
        Ordered list of DiffOp describing each difference.
    """
    norm_ocr = [_normalize(w) for w in ocr_words]
    norm_ref = [_normalize(w) for w in reference_words]

    matcher = difflib.SequenceMatcher(None, norm_ocr, norm_ref, autojunk=False)
    ops: list[DiffOp] = []

    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for ocr_idx, ref_idx in zip(range(i1, i2), range(j1, j2)):
                ops.append(DiffOp(
                    diff_type=DiffType.CORRECT,
                    ocr_index=ocr_idx,
                    ref_index=ref_idx,
                    ocr_word=ocr_words[ocr_idx],
                    reference_word=reference_words[ref_idx],
                ))
        elif tag == "replace":
            # Pair up replacements; handle uneven lengths
            ocr_range = list(range(i1, i2))
            ref_range = list(range(j1, j2))
            max_len = max(len(ocr_range), len(ref_range))
            for k in range(max_len):
                if k < len(ocr_range) and k < len(ref_range):
                    ops.append(DiffOp(
                        diff_type=DiffType.WRONG,
                        ocr_index=ocr_range[k],
                        ref_index=ref_range[k],
                        ocr_word=ocr_words[ocr_range[k]],
                        reference_word=reference_words[ref_range[k]],
                    ))
                elif k < len(ocr_range):
                    ops.append(DiffOp(
                        diff_type=DiffType.EXTRA,
                        ocr_index=ocr_range[k],
                        ref_index=None,
                        ocr_word=ocr_words[ocr_range[k]],
                        reference_word=None,
                    ))
                else:
                    ops.append(DiffOp(
                        diff_type=DiffType.MISSING,
                        ocr_index=None,
                        ref_index=ref_range[k],
                        ocr_word=None,
                        reference_word=reference_words[ref_range[k]],
                    ))
        elif tag == "delete":
            # OCR has extra words not in reference
            for ocr_idx in range(i1, i2):
                ops.append(DiffOp(
                    diff_type=DiffType.EXTRA,
                    ocr_index=ocr_idx,
                    ref_index=None,
                    ocr_word=ocr_words[ocr_idx],
                    reference_word=None,
                ))
        elif tag == "insert":
            # Reference has words missing from OCR
            for ref_idx in range(j1, j2):
                ops.append(DiffOp(
                    diff_type=DiffType.MISSING,
                    ocr_index=None,
                    ref_index=ref_idx,
                    ocr_word=None,
                    reference_word=reference_words[ref_idx],
                ))

    raw_ops = _fix_contractions(ops, ocr_words, reference_words)
    # Strip edge punctuation from all word fields so every downstream consumer
    # (DB, annotated images, UI diff display) sees clean words.
    return [
        DiffOp(
            diff_type=op.diff_type,
            ocr_index=op.ocr_index,
            ref_index=op.ref_index,
            ocr_word=_strip_display(op.ocr_word),
            reference_word=_strip_display(op.reference_word),
        )
        for op in raw_ops
    ]
