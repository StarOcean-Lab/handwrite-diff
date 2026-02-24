"""Annotation planner — merge adjacent error words into phrase-level blocks.

Reduces label density on annotated images by grouping consecutive error ops
before rendering.  Inspired by ERRANT (Bryant et al., ACL 2017) minimal-span
phrase annotation idea.

Scope
-----
Only affects ``annotate_image()`` (backend OpenCV rendering called during the
processing pipeline).  The generated image is stored as
``ImageRecord.annotated_image_path`` and shown in the task/image review pages
as well as ZIP exports.

The frontend SVG interactive editor (``render_from_annotations()``) and the
DB-stored ``diff_result_json`` are untouched.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from app.services.diff_engine import DiffOp, DiffType

# Maximum number of consecutive error ops that can be merged into one phrase block.
MAX_PHRASE_SIZE: int = 4


class BlockKind(str, Enum):
    SINGLE = "single"   # One op; uses the original per-word rendering path.
    PHRASE = "phrase"   # Two–MAX_PHRASE_SIZE ops merged into one visual block.


@dataclass(frozen=True)
class AnnotationBlock:
    """A unit of annotation to be rendered onto the image.

    For SINGLE blocks exactly one op is present and all phrase-specific fields
    are None.  For PHRASE blocks ``union_bbox`` is always set (otherwise the
    block is downgraded to individual SINGLE blocks).
    """

    kind: BlockKind
    ops: tuple[DiffOp, ...]

    # Phrase-only fields (None for SINGLE blocks)
    union_bbox: tuple[int, int, int, int] | None = None
    correct_text: str | None = None      # Text label to show above the rect.
    color_hint: str | None = None        # "wrong" | "extra" | "missing"


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------

def _get_op_bbox(
    op: DiffOp,
    ocr_words: list[dict],
) -> tuple[int, int, int, int] | None:
    """Return the pixel bbox for *op* from *ocr_words*, or None for MISSING."""
    if op.ocr_index is None or op.ocr_index >= len(ocr_words):
        return None
    raw = ocr_words[op.ocr_index]["bbox"]
    return (int(raw[0]), int(raw[1]), int(raw[2]), int(raw[3]))


def _on_same_line(
    bbox_a: tuple[int, int, int, int],
    bbox_b: tuple[int, int, int, int],
) -> bool:
    """Return True if the two bboxes sit on the same text line.

    Criterion: vertical-centre distance < 0.6 × average bbox height.
    """
    h_a = max(bbox_a[3] - bbox_a[1], 1)
    h_b = max(bbox_b[3] - bbox_b[1], 1)
    avg_h = (h_a + h_b) / 2.0
    cy_a = (bbox_a[1] + bbox_a[3]) / 2.0
    cy_b = (bbox_b[1] + bbox_b[3]) / 2.0
    return abs(cy_a - cy_b) < avg_h * 0.6


def _horizontally_adjacent(
    bbox_a: tuple[int, int, int, int],
    bbox_b: tuple[int, int, int, int],
) -> bool:
    """Return True if the two bboxes are close enough horizontally.

    Criterion: horizontal gap < 2.0 × average bbox height.  Handles
    overlapping or touching bboxes (gap ≤ 0) as adjacent.
    """
    h_a = max(bbox_a[3] - bbox_a[1], 1)
    h_b = max(bbox_b[3] - bbox_b[1], 1)
    avg_h = (h_a + h_b) / 2.0
    x_gap = bbox_b[0] - bbox_a[2]   # negative when bboxes overlap
    return x_gap < avg_h * 2.0


def _label_fits(correct_text: str, avg_bbox_h: int, image_width: int) -> bool:
    """Return True if *correct_text* can be rendered within *image_width*.

    Uses a rough per-character width estimate of 0.6 × avg_bbox_h.
    """
    if image_width <= 0:
        return True
    estimated_char_w = max(avg_bbox_h, 1) * 0.6
    estimated_label_w = len(correct_text) * estimated_char_w
    return estimated_label_w <= image_width * 0.9


# ---------------------------------------------------------------------------
# Phrase-block attribute builders
# ---------------------------------------------------------------------------

def _compute_union_bbox(
    ops: tuple[DiffOp, ...],
    ocr_words: list[dict],
) -> tuple[int, int, int, int] | None:
    """Union of all pixel bboxes in *ops* that have an ocr_index.

    Returns None when every op is a MISSING (no bbox available).
    """
    bboxes = [
        b for op in ops
        if (b := _get_op_bbox(op, ocr_words)) is not None
    ]
    if not bboxes:
        return None
    return (
        min(b[0] for b in bboxes),
        min(b[1] for b in bboxes),
        max(b[2] for b in bboxes),
        max(b[3] for b in bboxes),
    )


def _build_correct_text(ops: tuple[DiffOp, ...]) -> str | None:
    """Build the correction label for a phrase block.

    WRONG  → include reference_word
    MISSING → include reference_word
    EXTRA  → skip (no corresponding correct form)

    Returns None when all ops are EXTRA (no correction to show).
    """
    parts = [
        op.reference_word
        for op in ops
        if op.diff_type in (DiffType.WRONG, DiffType.MISSING)
        and op.reference_word
    ]
    return " ".join(parts) if parts else None


def _choose_color_hint(ops: tuple[DiffOp, ...]) -> str:
    """Choose a color hint for the phrase block.

    Priority: WRONG (red) > all-EXTRA (orange) > otherwise MISSING (blue).
    """
    types = {op.diff_type for op in ops}
    if DiffType.WRONG in types:
        return "wrong"
    if types == {DiffType.EXTRA}:
        return "extra"
    return "missing"


# ---------------------------------------------------------------------------
# Core planner
# ---------------------------------------------------------------------------

def _try_make_phrase_block(
    ops: list[DiffOp],
    ocr_words: list[dict],
    image_width: int,
) -> AnnotationBlock | None:
    """Attempt to build a PHRASE block from *ops*.

    Returns None and signals the caller to fall back to SINGLE blocks when:
    - All ops are MISSING (union_bbox would be None — no position).
    - The correct_text label would not fit in *image_width*.
    """
    ops_tuple = tuple(ops)
    union_bbox = _compute_union_bbox(ops_tuple, ocr_words)
    if union_bbox is None:
        return None

    correct_text = _build_correct_text(ops_tuple)
    color_hint = _choose_color_hint(ops_tuple)

    if correct_text is not None:
        avg_bbox_h = union_bbox[3] - union_bbox[1]
        if not _label_fits(correct_text, avg_bbox_h, image_width):
            return None

    return AnnotationBlock(
        kind=BlockKind.PHRASE,
        ops=ops_tuple,
        union_bbox=union_bbox,
        correct_text=correct_text,
        color_hint=color_hint,
    )


def plan_annotations(
    diff_ops: list[DiffOp],
    ocr_words: list[dict],
    image_width: int = 9999,
) -> list[AnnotationBlock]:
    """Build an ordered list of AnnotationBlocks from *diff_ops*.

    Greedy left-to-right scan.  CORRECT ops produce no blocks.  Adjacent
    error ops on the same line are merged into PHRASE blocks up to
    ``MAX_PHRASE_SIZE``.  When merging would fail (pure-MISSING run, label
    too wide, cross-line, over-spaced), each op falls back to its own
    SINGLE block.

    Args:
        diff_ops:    Word-level diff operations from ``compute_word_diff()``.
        ocr_words:   OCR word list — dicts with ``bbox`` [x1,y1,x2,y2].
        image_width: Image width in pixels (used to guard overly-wide labels).

    Returns:
        Ordered list of ``AnnotationBlock`` ready for rendering.
    """
    blocks: list[AnnotationBlock] = []
    i = 0

    while i < len(diff_ops):
        op = diff_ops[i]

        # CORRECT ops generate nothing
        if op.diff_type == DiffType.CORRECT:
            i += 1
            continue

        # Start a run with the current error op
        run: list[DiffOp] = [op]
        j = i + 1

        # Greedily extend the run to the right
        while j < len(diff_ops) and len(run) < MAX_PHRASE_SIZE:
            next_op = diff_ops[j]

            # CORRECT is always a hard boundary
            if next_op.diff_type == DiffType.CORRECT:
                break

            # Find the last bbox we've accumulated so far (anchor)
            anchor_bbox: tuple[int, int, int, int] | None = None
            for prev_op in reversed(run):
                b = _get_op_bbox(prev_op, ocr_words)
                if b is not None:
                    anchor_bbox = b
                    break

            next_bbox = _get_op_bbox(next_op, ocr_words)

            if anchor_bbox is not None and next_bbox is not None:
                # Both sides have position → enforce proximity constraints
                if not _on_same_line(anchor_bbox, next_bbox):
                    break
                if not _horizontally_adjacent(anchor_bbox, next_bbox):
                    break
            elif anchor_bbox is None and next_bbox is None:
                # Pure-MISSING sequence: no spatial anchor, stop extending
                break
            # One side has a bbox (MISSING sandwiched between real words): allow

            run.append(next_op)
            j += 1

        # Decide how to emit the run
        if len(run) == 1:
            blocks.append(AnnotationBlock(kind=BlockKind.SINGLE, ops=(run[0],)))
        else:
            phrase = _try_make_phrase_block(run, ocr_words, image_width)
            if phrase is not None:
                blocks.append(phrase)
            else:
                # Fallback: each op in the run becomes its own SINGLE block
                for fallback_op in run:
                    blocks.append(AnnotationBlock(kind=BlockKind.SINGLE, ops=(fallback_op,)))

        i = j

    return blocks
