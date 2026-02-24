"""Unit tests for the annotation planner.

Pure-Python tests — no OpenCV or image I/O required.
All tests operate on synthetic DiffOp / ocr_words data.
"""

from __future__ import annotations

import pytest

from app.services.annotation_planner import (
    MAX_PHRASE_SIZE,
    AnnotationBlock,
    BlockKind,
    _build_correct_text,
    _choose_color_hint,
    _compute_union_bbox,
    _horizontally_adjacent,
    _label_fits,
    _on_same_line,
    plan_annotations,
)
from app.services.diff_engine import DiffOp, DiffType


# ---------------------------------------------------------------------------
# Test-data helpers
# ---------------------------------------------------------------------------

def _word(x1: int, y1: int, x2: int, y2: int, text: str = "w") -> dict:
    """Create an ocr_words entry with the given pixel bbox."""
    return {"text": text, "bbox": [x1, y1, x2, y2], "confidence": 0.9}


def _wrong(
    ocr_idx: int,
    ref_idx: int,
    ocr_word: str = "bad",
    ref_word: str = "good",
) -> DiffOp:
    return DiffOp(DiffType.WRONG, ocr_idx, ref_idx, ocr_word, ref_word)


def _extra(ocr_idx: int, ocr_word: str = "extra") -> DiffOp:
    return DiffOp(DiffType.EXTRA, ocr_idx, None, ocr_word, None)


def _missing(ref_idx: int, ref_word: str = "miss") -> DiffOp:
    return DiffOp(DiffType.MISSING, None, ref_idx, None, ref_word)


def _correct(ocr_idx: int, ref_idx: int, word: str = "ok") -> DiffOp:
    return DiffOp(DiffType.CORRECT, ocr_idx, ref_idx, word, word)


# ---------------------------------------------------------------------------
# _on_same_line
# ---------------------------------------------------------------------------

class TestSameLine:
    def test_identical_bboxes_are_same_line(self) -> None:
        a = (10, 50, 60, 80)
        assert _on_same_line(a, a) is True

    def test_horizontally_offset_same_y_is_same_line(self) -> None:
        a = (0, 50, 50, 80)
        b = (60, 50, 110, 80)
        assert _on_same_line(a, b) is True

    def test_large_vertical_gap_is_different_line(self) -> None:
        a = (0, 50, 50, 80)     # height 30, cy=65
        b = (0, 200, 50, 230)   # height 30, cy=215  → |65-215|=150 >> 18
        assert _on_same_line(a, b) is False

    def test_small_vertical_difference_within_threshold(self) -> None:
        # avg_h = 30, threshold = 30*0.6 = 18; |cy_a - cy_b| = 10 → same line
        a = (0, 50, 50, 80)   # cy = 65
        b = (60, 55, 110, 85)  # cy = 70  → diff = 5
        assert _on_same_line(a, b) is True

    def test_vertical_difference_at_boundary_is_not_same_line(self) -> None:
        # avg_h = 20, threshold = 20*0.6 = 12; cy_diff = 13 → different line
        a = (0, 50, 50, 70)   # h=20, cy=60
        b = (60, 63, 110, 83)  # h=20, cy=73  → diff=13 > 12
        assert _on_same_line(a, b) is False

    def test_degenerate_zero_height_does_not_crash(self) -> None:
        a = (0, 50, 50, 50)   # height = 0 → clamped to 1
        b = (60, 50, 110, 50)
        # Both cy = 50, diff = 0 → same line
        assert _on_same_line(a, b) is True


# ---------------------------------------------------------------------------
# _horizontally_adjacent
# ---------------------------------------------------------------------------

class TestHorizontallyAdjacent:
    def test_touching_bboxes_are_adjacent(self) -> None:
        a = (0, 50, 50, 80)
        b = (50, 50, 100, 80)   # gap = 0
        assert _horizontally_adjacent(a, b) is True

    def test_small_gap_is_adjacent(self) -> None:
        # avg_h = 30, threshold = 60; gap = 20 → adjacent
        a = (0, 50, 50, 80)
        b = (70, 50, 120, 80)   # gap = 20
        assert _horizontally_adjacent(a, b) is True

    def test_large_gap_is_not_adjacent(self) -> None:
        # avg_h = 30, threshold = 60; gap = 100 → not adjacent
        a = (0, 50, 50, 80)
        b = (150, 50, 200, 80)  # gap = 100
        assert _horizontally_adjacent(a, b) is False

    def test_overlapping_bboxes_are_adjacent(self) -> None:
        # gap = bbox_b[0] - bbox_a[2] = 30 - 50 = -20 (negative) → adjacent
        a = (0, 50, 50, 80)
        b = (30, 50, 80, 80)
        assert _horizontally_adjacent(a, b) is True

    def test_gap_exactly_at_threshold_is_adjacent(self) -> None:
        # avg_h = 30, threshold = 60; gap = 59 → adjacent (< 60)
        a = (0, 50, 50, 80)
        b = (109, 50, 160, 80)  # gap = 109 - 50 = 59
        assert _horizontally_adjacent(a, b) is True

    def test_gap_just_over_threshold_is_not_adjacent(self) -> None:
        # avg_h = 30, threshold = 60; gap = 61 → not adjacent
        a = (0, 50, 50, 80)
        b = (111, 50, 160, 80)  # gap = 111 - 50 = 61
        assert _horizontally_adjacent(a, b) is False


# ---------------------------------------------------------------------------
# _build_correct_text
# ---------------------------------------------------------------------------

class TestBuildCorrectText:
    def test_all_wrong_returns_ref_words(self) -> None:
        ops = (
            _wrong(0, 0, "a", "b"),
            _wrong(1, 1, "c", "d"),
        )
        assert _build_correct_text(ops) == "b d"

    def test_with_missing_includes_ref_word(self) -> None:
        ops = (
            _wrong(0, 0, "a", "b"),
            _missing(1, "c"),
        )
        assert _build_correct_text(ops) == "b c"

    def test_extra_is_skipped(self) -> None:
        ops = (
            _extra(0, "foo"),
            _wrong(1, 0, "set", "sat"),
        )
        assert _build_correct_text(ops) == "sat"

    def test_all_extra_returns_none(self) -> None:
        ops = (
            _extra(0, "x"),
            _extra(1, "y"),
        )
        assert _build_correct_text(ops) is None

    def test_single_missing_with_ref_word(self) -> None:
        ops = (_missing(0, "hello"),)
        assert _build_correct_text(ops) == "hello"

    def test_empty_ops_returns_none(self) -> None:
        assert _build_correct_text(()) is None


# ---------------------------------------------------------------------------
# _choose_color_hint
# ---------------------------------------------------------------------------

class TestChooseColorHint:
    def test_with_wrong_returns_wrong(self) -> None:
        ops = (_extra(0), _wrong(1, 0))
        assert _choose_color_hint(ops) == "wrong"

    def test_all_extra_returns_extra(self) -> None:
        ops = (_extra(0), _extra(1))
        assert _choose_color_hint(ops) == "extra"

    def test_missing_only_returns_missing(self) -> None:
        ops = (_missing(0), _missing(1))
        assert _choose_color_hint(ops) == "missing"

    def test_extra_and_missing_returns_missing(self) -> None:
        ops = (_extra(0), _missing(1))
        assert _choose_color_hint(ops) == "missing"

    def test_wrong_dominates_over_missing(self) -> None:
        ops = (_wrong(0, 0), _missing(1))
        assert _choose_color_hint(ops) == "wrong"


# ---------------------------------------------------------------------------
# _compute_union_bbox
# ---------------------------------------------------------------------------

class TestComputeUnionBbox:
    def test_two_non_overlapping_words(self) -> None:
        ops = (_wrong(0, 0), _wrong(1, 1))
        words = [_word(10, 50, 60, 80), _word(70, 50, 120, 80)]
        result = _compute_union_bbox(ops, words)
        assert result == (10, 50, 120, 80)

    def test_missing_op_excluded_from_bbox(self) -> None:
        ops = (_wrong(0, 0), _missing(1))
        words = [_word(10, 50, 60, 80)]
        result = _compute_union_bbox(ops, words)
        # Only op 0 has a bbox
        assert result == (10, 50, 60, 80)

    def test_all_missing_returns_none(self) -> None:
        ops = (_missing(0), _missing(1))
        words: list[dict] = []
        assert _compute_union_bbox(ops, words) is None

    def test_union_expands_to_enclose_both_bboxes(self) -> None:
        ops = (_wrong(0, 0), _wrong(1, 1))
        words = [_word(5, 30, 40, 60), _word(50, 20, 90, 70)]
        result = _compute_union_bbox(ops, words)
        assert result == (5, 20, 90, 70)

    def test_extra_op_uses_ocr_index(self) -> None:
        ops = (_extra(0), _extra(1))
        words = [_word(0, 0, 30, 20), _word(40, 0, 70, 20)]
        result = _compute_union_bbox(ops, words)
        assert result == (0, 0, 70, 20)


# ---------------------------------------------------------------------------
# _label_fits
# ---------------------------------------------------------------------------

class TestLabelFits:
    def test_short_label_fits(self) -> None:
        # "hi" (2 chars), avg_h=40 → estimated_w = 2 * 40 * 0.6 = 48; limit = 800*0.9 = 720
        assert _label_fits("hi", 40, 800) is True

    def test_very_long_label_does_not_fit(self) -> None:
        # 100-char label, avg_h=50 → 100 * 50 * 0.6 = 3000; limit = 800*0.9 = 720
        long_text = "x" * 100
        assert _label_fits(long_text, 50, 800) is False

    def test_zero_image_width_always_fits(self) -> None:
        assert _label_fits("anything", 40, 0) is True

    def test_label_exactly_at_limit(self) -> None:
        # 10 chars, avg_h=12 → 10 * 12 * 0.6 = 72; limit = 80 * 0.9 = 72; 72 <= 72 → True
        assert _label_fits("x" * 10, 12, 80) is True


# ---------------------------------------------------------------------------
# plan_annotations — integration tests
# ---------------------------------------------------------------------------

class TestPlanAnnotations:
    # --- empty / trivial -------------------------------------------------

    def test_empty_input_returns_empty_list(self) -> None:
        assert plan_annotations([], [], 1000) == []

    def test_all_correct_produces_no_blocks(self) -> None:
        ops = [_correct(0, 0), _correct(1, 1)]
        words = [_word(0, 0, 50, 30), _word(60, 0, 110, 30)]
        blocks = plan_annotations(ops, words, 1000)
        assert blocks == []

    # --- single errors ---------------------------------------------------

    def test_single_wrong_produces_one_single_block(self) -> None:
        ops = [_wrong(0, 0)]
        words = [_word(0, 0, 50, 30)]
        blocks = plan_annotations(ops, words, 1000)
        assert len(blocks) == 1
        assert blocks[0].kind == BlockKind.SINGLE
        assert blocks[0].ops == (ops[0],)

    def test_single_extra_produces_one_single_block(self) -> None:
        ops = [_extra(0)]
        words = [_word(0, 0, 50, 30)]
        blocks = plan_annotations(ops, words, 1000)
        assert len(blocks) == 1
        assert blocks[0].kind == BlockKind.SINGLE

    def test_single_missing_produces_one_single_block(self) -> None:
        ops = [_missing(0)]
        words: list[dict] = []
        blocks = plan_annotations(ops, words, 1000)
        assert len(blocks) == 1
        assert blocks[0].kind == BlockKind.SINGLE

    # --- phrase merging --------------------------------------------------

    def test_two_adjacent_wrongs_merge_into_phrase(self) -> None:
        ops = [_wrong(0, 0, "a", "b"), _wrong(1, 1, "c", "d")]
        words = [_word(0, 50, 50, 80), _word(60, 50, 110, 80)]   # same line, close
        blocks = plan_annotations(ops, words, 1000)
        assert len(blocks) == 1
        assert blocks[0].kind == BlockKind.PHRASE
        assert len(blocks[0].ops) == 2
        assert blocks[0].correct_text == "b d"
        assert blocks[0].color_hint == "wrong"
        assert blocks[0].union_bbox == (0, 50, 110, 80)

    def test_extra_and_wrong_merge_with_correct_text_from_wrong_only(self) -> None:
        ops = [_extra(0, "foo"), _wrong(1, 0, "set", "sat")]
        words = [_word(0, 50, 50, 80), _word(60, 50, 110, 80)]
        blocks = plan_annotations(ops, words, 1000)
        assert len(blocks) == 1
        assert blocks[0].kind == BlockKind.PHRASE
        assert blocks[0].correct_text == "sat"

    def test_phrase_block_includes_missing_sandwiched_between_wrongs(self) -> None:
        ops = [_wrong(0, 0, "a", "b"), _missing(1, "c"), _wrong(1, 2, "d", "e")]
        words = [_word(0, 50, 50, 80), _word(60, 50, 110, 80)]
        blocks = plan_annotations(ops, words, 1000)
        # Should merge: anchor=bbox0, next=MISSING(no bbox) → allow;
        # anchor still=bbox0, next=WRONG(bbox1) → check adjacency
        assert len(blocks) == 1
        assert blocks[0].kind == BlockKind.PHRASE
        assert blocks[0].correct_text == "b c e"

    # --- boundary conditions ---------------------------------------------

    def test_correct_op_breaks_phrase_group(self) -> None:
        ops = [_wrong(0, 0), _correct(1, 1), _wrong(2, 2)]
        words = [_word(0, 50, 50, 80), _word(60, 50, 110, 80), _word(120, 50, 170, 80)]
        blocks = plan_annotations(ops, words, 1000)
        assert len(blocks) == 2
        assert all(b.kind == BlockKind.SINGLE for b in blocks)

    def test_cross_line_words_do_not_merge(self) -> None:
        # Word 0 at y=50–80, word 1 at y=200–230 → different lines
        ops = [_wrong(0, 0), _wrong(1, 1)]
        words = [_word(0, 50, 50, 80), _word(60, 200, 110, 230)]
        blocks = plan_annotations(ops, words, 1000)
        assert len(blocks) == 2
        assert all(b.kind == BlockKind.SINGLE for b in blocks)

    def test_too_far_apart_horizontally_do_not_merge(self) -> None:
        # avg_h = 30, threshold = 60; gap = 200 → not adjacent
        ops = [_wrong(0, 0), _wrong(1, 1)]
        words = [_word(0, 50, 50, 80), _word(250, 50, 300, 80)]
        blocks = plan_annotations(ops, words, 1000)
        assert len(blocks) == 2
        assert all(b.kind == BlockKind.SINGLE for b in blocks)

    def test_two_missing_ops_do_not_merge_pure_missing_sequence(self) -> None:
        ops = [_missing(0), _missing(1)]
        words: list[dict] = []
        blocks = plan_annotations(ops, words, 1000)
        assert len(blocks) == 2
        assert all(b.kind == BlockKind.SINGLE for b in blocks)

    def test_max_phrase_size_limits_group(self) -> None:
        # 5 adjacent WRONGs → one PHRASE(4) + one SINGLE(1)
        words = [_word(i * 60, 50, i * 60 + 50, 80) for i in range(5)]
        ops = [_wrong(i, i) for i in range(5)]
        blocks = plan_annotations(ops, words, 2000)
        assert len(blocks) == 2
        phrase, single = blocks
        assert phrase.kind == BlockKind.PHRASE
        assert len(phrase.ops) == MAX_PHRASE_SIZE
        assert single.kind == BlockKind.SINGLE

    def test_all_extra_phrase_has_none_correct_text(self) -> None:
        ops = [_extra(0), _extra(1)]
        words = [_word(0, 50, 50, 80), _word(60, 50, 110, 80)]
        blocks = plan_annotations(ops, words, 1000)
        assert len(blocks) == 1
        assert blocks[0].kind == BlockKind.PHRASE
        assert blocks[0].correct_text is None
        assert blocks[0].color_hint == "extra"

    def test_narrow_image_width_prevents_phrase_merge(self) -> None:
        # Long correct_text that would exceed a very narrow image width
        # "good1 good2" (11 chars), avg_h ≈ 30 → estimated_w = 11 * 18 = 198; limit = 20 * 0.9 = 18
        ops = [_wrong(0, 0, "a", "good1"), _wrong(1, 1, "b", "good2")]
        words = [_word(0, 50, 50, 80), _word(60, 50, 110, 80)]
        blocks = plan_annotations(ops, words, image_width=20)
        assert len(blocks) == 2
        assert all(b.kind == BlockKind.SINGLE for b in blocks)

    # --- ordering preservation -------------------------------------------

    def test_blocks_preserve_op_order(self) -> None:
        # WRONG, CORRECT, WRONG, WRONG → SINGLE, (skip CORRECT), PHRASE
        words = [_word(i * 60, 50, i * 60 + 50, 80) for i in range(4)]
        ops = [
            _wrong(0, 0),
            _correct(1, 1),
            _wrong(2, 2),
            _wrong(3, 3),
        ]
        blocks = plan_annotations(ops, words, 1000)
        assert len(blocks) == 2
        assert blocks[0].kind == BlockKind.SINGLE
        assert blocks[0].ops[0] is ops[0]
        assert blocks[1].kind == BlockKind.PHRASE
        assert blocks[1].ops[0] is ops[2]
        assert blocks[1].ops[1] is ops[3]

    def test_mixed_types_in_phrase(self) -> None:
        # EXTRA + WRONG → PHRASE with color_hint="wrong"
        ops = [_extra(0), _wrong(1, 0, "x", "y")]
        words = [_word(0, 50, 50, 80), _word(60, 50, 110, 80)]
        blocks = plan_annotations(ops, words, 1000)
        assert len(blocks) == 1
        block = blocks[0]
        assert block.kind == BlockKind.PHRASE
        assert block.color_hint == "wrong"

    def test_phrase_union_bbox_excludes_missing(self) -> None:
        # WRONG(idx=0) + MISSING → union_bbox should only be from WRONG
        ops = [_wrong(0, 0, "a", "b"), _missing(1, "c")]
        words = [_word(10, 50, 60, 80)]
        # anchor_bbox = (10,50,60,80); next op MISSING has no bbox → allow merge
        blocks = plan_annotations(ops, words, 1000)
        # MISSING op has no bbox → can still merge if one op has bbox
        assert len(blocks) == 1
        assert blocks[0].kind == BlockKind.PHRASE
        assert blocks[0].union_bbox == (10, 50, 60, 80)
