"""Image annotator — draw diff results onto original images using OpenCV.

Annotation types:
  WRONG  → Red ellipse around bbox + reference word above
  EXTRA  → Orange strikethrough line across the word
  MISSING → Blue caret marker (^[word]) between adjacent words

Correction text is sized proportionally to each word's bounding box so that
it remains legible regardless of image resolution.

Label overlap prevention:
  Before rendering, all label rectangles are collected and a greedy upward-shift
  algorithm resolves overlaps.  The computed y-offsets are passed to drawing
  functions so that labels never visually collide.
"""

import functools
import logging
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from app.services.diff_engine import DiffOp, DiffType

logger = logging.getLogger("handwrite_diff.annotator")

# Colors (BGR for OpenCV)
COLOR_WRONG = (0, 0, 220)       # Red
COLOR_EXTRA = (0, 140, 255)     # Orange
COLOR_MISSING = (220, 120, 0)   # Blue

# Colors (RGB for PIL)
_COLOR_WRONG_RGB = (220, 0, 0)
_COLOR_MISSING_RGB = (0, 120, 220)

# ─── PIL TrueType font helpers for export rendering ─────────────────────────
# Using PIL instead of OpenCV's HERSHEY stroke font ensures that
# font sizing matches SVG em-box semantics used by the frontend editor.

_SANS_BOLD_FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",  # Arial-compatible
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
]


def _find_sans_bold_font() -> str | None:
    """Find a sans-serif bold TrueType font on the system."""
    for p in _SANS_BOLD_FONT_CANDIDATES:
        if Path(p).exists():
            return p
    return None


@functools.lru_cache(maxsize=64)
def _get_pil_font(font_path: str, size: int) -> ImageFont.FreeTypeFont:
    """Load and cache a PIL TrueType font at the given em-box size."""
    return ImageFont.truetype(font_path, size=max(size, 6))


_EXPORT_FONT_PATH: str | None = _find_sans_bold_font()


@dataclass(frozen=True)
class AnnotationStyle:
    """Visual parameters for annotations.

    Thickness values are *base* values for ~1000 px tall images and are scaled
    at runtime.  Font size is always derived from each word's bbox height so
    that correction text matches handwriting size.
    """
    ellipse_thickness: int = 3
    strikethrough_thickness: int = 3
    # Multiplier applied to bbox height to get correction-text height.
    # 0.8 means the red text is ~80 % as tall as the handwritten word.
    font_height_ratio: float = 0.8
    text_gap: int = 6          # px gap between word top and text bottom
    caret_size: int = 10
    # Reference height used to compute the resolution multiplier.
    _reference_height: int = 1000

    def scaled(self, image_height: int) -> "AnnotationStyle":
        """Return a copy with line/shape parameters scaled to *image_height*."""
        factor = max(image_height / self._reference_height, 1.0)
        return AnnotationStyle(
            ellipse_thickness=max(round(self.ellipse_thickness * factor), 1),
            strikethrough_thickness=max(round(self.strikethrough_thickness * factor), 1),
            font_height_ratio=self.font_height_ratio,
            text_gap=max(round(self.text_gap * factor), 2),
            caret_size=round(self.caret_size * factor),
        )


# ─── Label rectangle helpers ────────────────────────────────────────────────

@dataclass(frozen=True)
class LabelRect:
    """Axis-aligned bounding box of a label drawn above a word."""
    op_index: int
    x: int
    y: int
    width: int
    height: int


def _compute_label_rect(
    img: np.ndarray,
    ocr_words: list[dict],
    op: DiffOp,
    op_index: int,
    all_ops: list[DiffOp],
    style: AnnotationStyle,
) -> LabelRect | None:
    """Compute the AABB of a label that would be drawn for *op*.

    Returns None if the op has no visible label (no reference_word or no bbox).
    """
    if not op.reference_word:
        return None

    if op.diff_type == DiffType.WRONG:
        bbox = _get_bbox(ocr_words, op.ocr_index)
        if bbox is None:
            return None
        x1, y1, x2, y2 = bbox
        bbox_h = y2 - y1
        cx = (x1 + x2) // 2
        font_scale, font_thick = _font_params_for_bbox(bbox_h, style)
        text_size = cv2.getTextSize(
            op.reference_word, cv2.FONT_HERSHEY_SIMPLEX, font_scale, font_thick,
        )[0]
        text_x = cx - text_size[0] // 2
        text_y = y1 - style.text_gap
        return LabelRect(
            op_index=op_index,
            x=text_x,
            y=text_y - text_size[1],
            width=text_size[0],
            height=text_size[1],
        )

    if op.diff_type == DiffType.MISSING:
        insert_x, insert_y, neighbor_bbox_h = _find_missing_position(
            ocr_words, op, all_ops,
        )
        if insert_x is None:
            return None
        caret_top = insert_y - style.caret_size
        font_scale, font_thick = _font_params_for_bbox(neighbor_bbox_h, style)
        text_size = cv2.getTextSize(
            op.reference_word, cv2.FONT_HERSHEY_SIMPLEX, font_scale, font_thick,
        )[0]
        text_x = insert_x - text_size[0] // 2
        text_y = caret_top - 4
        return LabelRect(
            op_index=op_index,
            x=text_x,
            y=text_y - text_size[1],
            width=text_size[0],
            height=text_size[1],
        )

    return None


def _rects_overlap(a: LabelRect, ay_offset: int, b: LabelRect, by_offset: int) -> bool:
    """AABB overlap test with y-offsets applied."""
    ax, ay = a.x, a.y + ay_offset
    bx, by_ = b.x, b.y + by_offset
    return (
        ax < bx + b.width
        and ax + a.width > bx
        and ay < by_ + b.height
        and ay + a.height > by_
    )


def _resolve_label_overlaps(label_rects: list[LabelRect]) -> dict[int, int]:
    """Resolve overlapping label rectangles by shifting later ones upward.

    Returns a mapping from op_index → y_offset (negative = upward).
    Entries with offset 0 are omitted.
    """
    if len(label_rects) <= 1:
        return {}

    # Sort by y then x for deterministic ordering
    sorted_rects = sorted(label_rects, key=lambda r: (r.y, r.x))
    offsets: dict[int, int] = {r.op_index: 0 for r in sorted_rects}

    max_iterations = 20
    for _ in range(max_iterations):
        any_adjusted = False
        for i in range(len(sorted_rects)):
            for j in range(i + 1, len(sorted_rects)):
                a = sorted_rects[i]
                b = sorted_rects[j]
                if _rects_overlap(a, offsets[a.op_index], b, offsets[b.op_index]):
                    # Push b upward
                    shift = -(b.height + 4)
                    offsets[b.op_index] += shift
                    any_adjusted = True
        if not any_adjusted:
            break

    # Return only non-zero offsets
    return {k: v for k, v in offsets.items() if v != 0}


# ─── Font helpers ────────────────────────────────────────────────────────────

def _font_params_for_bbox(
    bbox_height: int,
    style: AnnotationStyle,
) -> tuple[float, int]:
    """Compute cv2.putText font_scale and thickness from a word's bbox height.

    Returns:
        (font_scale, font_thickness)
    """
    target_px = bbox_height * style.font_height_ratio
    # cv2.FONT_HERSHEY_SIMPLEX baseline height ≈ 22 px at font_scale=1.0
    font_scale = max(target_px / 22.0, 0.4)
    font_thickness = max(round(font_scale * 1.5), 1)
    return font_scale, font_thickness


# ─── Main entry point ────────────────────────────────────────────────────────

def annotate_image(
    image_path: str,
    ocr_words: list[dict],
    diff_ops: list[DiffOp],
    output_path: str,
    style: AnnotationStyle | None = None,
) -> str:
    """Draw annotations on the original image and save to output_path.

    Three-phase pipeline:
      1. Collect label rectangles for all ops that render text.
      2. Resolve overlaps → compute per-op y-offsets.
      3. Render shapes and text with offsets applied.

    Args:
        image_path: Path to the original image.
        ocr_words: List of dicts with keys: text, bbox [x1,y1,x2,y2], confidence.
        diff_ops: Diff operations from compute_word_diff().
        output_path: Where to save the annotated image.
        style: Optional visual style overrides.

    Returns:
        The output_path string.
    """
    if style is None:
        style = AnnotationStyle()

    img = cv2.imread(image_path)
    if img is None:
        raise FileNotFoundError(f"Cannot read image: {image_path}")

    # Scale shape/line parameters to image resolution
    style = style.scaled(img.shape[0])

    # Phase 1: Collect label rectangles
    label_rects: list[LabelRect] = []
    for i, op in enumerate(diff_ops):
        if op.diff_type in (DiffType.WRONG, DiffType.MISSING):
            rect = _compute_label_rect(img, ocr_words, op, i, diff_ops, style)
            if rect is not None:
                label_rects.append(rect)

    # Phase 2: Resolve overlaps
    label_offsets = _resolve_label_overlaps(label_rects)

    # Phase 3: Render
    for i, op in enumerate(diff_ops):
        if op.diff_type == DiffType.CORRECT:
            continue

        y_offset = label_offsets.get(i, 0)

        if op.diff_type == DiffType.WRONG:
            _draw_wrong(img, ocr_words, op, style, label_y_offset=y_offset)
        elif op.diff_type == DiffType.EXTRA:
            _draw_extra(img, ocr_words, op, style)
        elif op.diff_type == DiffType.MISSING:
            _draw_missing(img, ocr_words, op, diff_ops, style, label_y_offset=y_offset)

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(output_path, img)
    logger.info("Annotated image saved: %s", output_path)
    return output_path


def _get_bbox(ocr_words: list[dict], index: int | None) -> tuple[int, int, int, int] | None:
    """Safely get bbox from OCR words list."""
    if index is None or index >= len(ocr_words):
        return None
    bbox = ocr_words[index]["bbox"]
    return (int(bbox[0]), int(bbox[1]), int(bbox[2]), int(bbox[3]))


def _draw_wrong(
    img: np.ndarray,
    ocr_words: list[dict],
    op: DiffOp,
    style: AnnotationStyle,
    label_y_offset: int = 0,
) -> None:
    """Draw red ellipse around wrong word + correct word above."""
    bbox = _get_bbox(ocr_words, op.ocr_index)
    if bbox is None:
        return

    x1, y1, x2, y2 = bbox
    cx = (x1 + x2) // 2
    cy = (y1 + y2) // 2
    bbox_h = y2 - y1
    w = (x2 - x1) // 2 + 6
    h = bbox_h // 2 + 4

    # Red ellipse
    cv2.ellipse(img, (cx, cy), (w, h), 0, 0, 360, COLOR_WRONG, style.ellipse_thickness)

    # Reference word above the ellipse — sized relative to the word
    if op.reference_word:
        text = op.reference_word
        font_scale, font_thick = _font_params_for_bbox(bbox_h, style)
        text_size = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, font_scale, font_thick)[0]
        text_x = cx - text_size[0] // 2
        text_y = y1 - style.text_gap + label_y_offset
        cv2.putText(
            img, text, (text_x, text_y),
            cv2.FONT_HERSHEY_SIMPLEX, font_scale, COLOR_WRONG, font_thick,
            cv2.LINE_AA,
        )


def _draw_extra(
    img: np.ndarray,
    ocr_words: list[dict],
    op: DiffOp,
    style: AnnotationStyle,
) -> None:
    """Draw orange strikethrough across extra word."""
    bbox = _get_bbox(ocr_words, op.ocr_index)
    if bbox is None:
        return

    x1, y1, x2, y2 = bbox
    cy = (y1 + y2) // 2
    cv2.line(img, (x1, cy), (x2, cy), COLOR_EXTRA, style.strikethrough_thickness)


def _draw_missing(
    img: np.ndarray,
    ocr_words: list[dict],
    op: DiffOp,
    all_ops: list[DiffOp],
    style: AnnotationStyle,
    label_y_offset: int = 0,
) -> None:
    """Draw blue caret marker for missing word.

    Position is interpolated between the preceding and following OCR words.
    """
    insert_x, insert_y, neighbor_bbox_h = _find_missing_position(ocr_words, op, all_ops)
    if insert_x is None:
        return

    # Draw caret symbol
    caret_top = insert_y - style.caret_size
    cv2.line(img, (insert_x - style.caret_size // 2, insert_y),
             (insert_x, caret_top), COLOR_MISSING, 2)
    cv2.line(img, (insert_x, caret_top),
             (insert_x + style.caret_size // 2, insert_y), COLOR_MISSING, 2)

    # Draw the missing word text above — sized relative to neighboring words
    if op.reference_word:
        text = op.reference_word
        font_scale, font_thick = _font_params_for_bbox(neighbor_bbox_h, style)
        text_size = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, font_scale, font_thick)[0]
        text_x = insert_x - text_size[0] // 2
        text_y = caret_top - 4 + label_y_offset
        cv2.putText(
            img, text, (text_x, text_y),
            cv2.FONT_HERSHEY_SIMPLEX, font_scale, COLOR_MISSING, font_thick,
            cv2.LINE_AA,
        )


def _find_missing_position(
    ocr_words: list[dict],
    op: DiffOp,
    all_ops: list[DiffOp],
) -> tuple[int | None, int | None, int]:
    """Estimate where a MISSING word should be placed on the image.

    Strategy: find the nearest OCR-indexed ops before and after this MISSING op,
    and interpolate between their bboxes.

    Returns:
        (x, y, neighbor_bbox_height) — height of the nearest neighbor word for
        font sizing; defaults to 40 if no neighbor found.
    """
    op_idx = None
    for i, o in enumerate(all_ops):
        if o is op:
            op_idx = i
            break
    if op_idx is None:
        return None, None, 40

    # Find previous and next ops with OCR indices
    prev_bbox = None
    next_bbox = None

    for i in range(op_idx - 1, -1, -1):
        bbox = _get_bbox(ocr_words, all_ops[i].ocr_index)
        if bbox:
            prev_bbox = bbox
            break

    for i in range(op_idx + 1, len(all_ops)):
        bbox = _get_bbox(ocr_words, all_ops[i].ocr_index)
        if bbox:
            next_bbox = bbox
            break

    # Estimate neighbor bbox height for font sizing
    if prev_bbox and next_bbox:
        neighbor_h = ((prev_bbox[3] - prev_bbox[1]) + (next_bbox[3] - next_bbox[1])) // 2
    elif prev_bbox:
        neighbor_h = prev_bbox[3] - prev_bbox[1]
    elif next_bbox:
        neighbor_h = next_bbox[3] - next_bbox[1]
    else:
        neighbor_h = 40

    if prev_bbox and next_bbox:
        x = (prev_bbox[2] + next_bbox[0]) // 2
        y = (prev_bbox[3] + next_bbox[3]) // 2
        return x, y, neighbor_h
    elif prev_bbox:
        return prev_bbox[2] + 10, (prev_bbox[1] + prev_bbox[3]) // 2, neighbor_h
    elif next_bbox:
        return next_bbox[0] - 10, (next_bbox[1] + next_bbox[3]) // 2, neighbor_h

    return None, None, neighbor_h


# ─── Export rendering from annotation dicts ──────────────────────────────────

@dataclass(frozen=True)
class _TextOp:
    """Collected text drawing operation for batch PIL rendering."""
    text: str
    center_x: int      # Horizontal center (matches SVG textAnchor="middle")
    baseline_y: int     # Baseline Y (matches SVG text y-coordinate)
    font_size: float    # SVG em-box pixels
    color_rgb: tuple    # (R, G, B) for PIL


def render_from_annotations(
    image_path: str,
    annotations: list[dict],
    scale_factor: float,
    output_path: str,
) -> str:
    """Render annotations directly from annotation dicts onto the original image.

    Unlike ``annotate_image`` which works from ``DiffOp`` objects and OCR word
    lists, this function uses pre-computed bbox coordinates stored in annotation
    dicts (as produced by the frontend editor).

    Text is rendered using PIL with a TrueType font so that font sizing matches
    the SVG em-box semantics used by the frontend editor.  Shapes (ellipses,
    lines, carets) are rendered with OpenCV.

    Args:
        image_path: Path to the original image.
        annotations: List of annotation dicts with keys: error_type,
            annotation_shape, bbox_x1/y1/x2/y2, reference_word, ocr_word.
        scale_factor: User-controlled multiplier for annotation visual size
            (line thickness, font size).  1.0 = default.
        output_path: Where to save the rendered image.

    Returns:
        The output_path string.
    """
    img = cv2.imread(image_path)
    if img is None:
        raise FileNotFoundError(f"Cannot read image: {image_path}")

    style = AnnotationStyle()
    # Apply image-resolution scaling, then user scale factor
    style = style.scaled(img.shape[0])
    style = AnnotationStyle(
        ellipse_thickness=max(round(style.ellipse_thickness * scale_factor), 1),
        strikethrough_thickness=max(round(style.strikethrough_thickness * scale_factor), 1),
        font_height_ratio=style.font_height_ratio,
        text_gap=max(round(style.text_gap * scale_factor), 2),
        caret_size=round(style.caret_size * scale_factor),
    )

    font_path = _EXPORT_FONT_PATH

    # Filter to error annotations with valid bboxes
    error_annotations = [
        ann for ann in annotations
        if ann.get("error_type") != "correct" and _has_valid_bbox(ann)
    ]

    # Phase 1: Collect label rectangles for overlap resolution
    label_rects: list[LabelRect] = []
    for i, ann in enumerate(error_annotations):
        rect = _compute_label_rect_from_annotation(img, ann, i, style, font_path)
        if rect is not None:
            label_rects.append(rect)

    # Phase 2: Resolve overlaps (only for labels without custom positions)
    auto_rects = [r for i, r in enumerate(label_rects)
                  if not _has_custom_label_position(error_annotations[r.op_index])]
    label_offsets = _resolve_label_overlaps(auto_rects)

    # Phase 3: Render shapes (OpenCV) and collect text operations
    text_ops: list[_TextOp] = []

    for i, ann in enumerate(error_annotations):
        y_offset = label_offsets.get(i, 0)
        error_type = ann.get("error_type", "")
        bbox = (
            int(ann["bbox_x1"]),
            int(ann["bbox_y1"]),
            int(ann["bbox_x2"]),
            int(ann["bbox_y2"]),
        )

        custom_lx = ann.get("label_x")
        custom_ly = ann.get("label_y")
        custom_fs = ann.get("label_font_size")

        if error_type == "wrong":
            _draw_wrong_shape(img, bbox, style)
            ref_word = ann.get("reference_word")
            if ref_word:
                text_ops.append(_build_text_op_wrong(
                    bbox, ref_word, style, y_offset,
                    custom_lx, custom_ly, custom_fs,
                    _COLOR_WRONG_RGB, font_path,
                ))
        elif error_type == "extra":
            _draw_extra_from_bbox(img, bbox, style)
        elif error_type == "missing":
            _draw_missing_shape(img, bbox, style)
            ref_word = ann.get("reference_word")
            if ref_word:
                text_ops.append(_build_text_op_missing(
                    bbox, ref_word, style, y_offset,
                    custom_lx, custom_ly, custom_fs,
                    _COLOR_MISSING_RGB, font_path,
                ))

    # Phase 4: Draw all text with PIL TrueType font
    if text_ops and font_path:
        _render_text_ops_pil(img, text_ops, font_path)
    elif text_ops:
        # Fallback: no TrueType font found, use OpenCV
        logger.warning("No TrueType font found; falling back to OpenCV text rendering")
        _render_text_ops_cv2(img, text_ops)

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(output_path, img)
    logger.info("Export rendered image saved: %s", output_path)
    return output_path


def _draw_wrong_shape(
    img: np.ndarray,
    bbox: tuple[int, int, int, int],
    style: AnnotationStyle,
) -> None:
    """Draw red ellipse around bbox (shape only, no text)."""
    x1, y1, x2, y2 = bbox
    cx = (x1 + x2) // 2
    cy = (y1 + y2) // 2
    w = (x2 - x1) // 2 + 6
    h = (y2 - y1) // 2 + 4
    cv2.ellipse(img, (cx, cy), (w, h), 0, 0, 360, COLOR_WRONG, style.ellipse_thickness)


def _draw_missing_shape(
    img: np.ndarray,
    bbox: tuple[int, int, int, int],
    style: AnnotationStyle,
) -> None:
    """Draw blue caret marker (shape only, no text)."""
    x1, y1, x2, y2 = bbox
    cx = (x1 + x2) // 2
    caret_bottom = y2
    caret_top = caret_bottom - style.caret_size
    cv2.line(img, (cx - style.caret_size // 2, caret_bottom),
             (cx, caret_top), COLOR_MISSING, 2)
    cv2.line(img, (cx, caret_top),
             (cx + style.caret_size // 2, caret_bottom), COLOR_MISSING, 2)


def _build_text_op_wrong(
    bbox: tuple[int, int, int, int],
    reference_word: str,
    style: AnnotationStyle,
    label_y_offset: int,
    label_x: float | None,
    label_y: float | None,
    label_font_size: float | None,
    color_rgb: tuple,
    font_path: str | None,
) -> _TextOp:
    """Build a text operation for a WRONG annotation label."""
    x1, y1, x2, y2 = bbox
    cx = (x1 + x2) // 2
    bbox_h = y2 - y1

    font_size = _effective_font_size(bbox_h, label_font_size, style)

    if label_x is not None and label_y is not None:
        center_x = int(label_x)
        baseline_y = int(label_y)
    else:
        center_x = cx
        # Compute baseline using PIL metrics for accurate placement
        baseline_y = _compute_default_baseline_y(
            reference_word, font_size, font_path,
            above_y=y1, gap=style.text_gap, y_offset=label_y_offset,
        )

    return _TextOp(
        text=reference_word,
        center_x=center_x,
        baseline_y=baseline_y,
        font_size=font_size,
        color_rgb=color_rgb,
    )


def _build_text_op_missing(
    bbox: tuple[int, int, int, int],
    reference_word: str,
    style: AnnotationStyle,
    label_y_offset: int,
    label_x: float | None,
    label_y: float | None,
    label_font_size: float | None,
    color_rgb: tuple,
    font_path: str | None,
) -> _TextOp:
    """Build a text operation for a MISSING annotation label."""
    x1, y1, x2, y2 = bbox
    cx = (x1 + x2) // 2
    bbox_h = y2 - y1

    font_size = _effective_font_size(bbox_h, label_font_size, style)
    caret_top = y2 - style.caret_size

    if label_x is not None and label_y is not None:
        center_x = int(label_x)
        baseline_y = int(label_y)
    else:
        center_x = cx
        baseline_y = _compute_default_baseline_y(
            reference_word, font_size, font_path,
            above_y=caret_top, gap=4, y_offset=label_y_offset,
        )

    return _TextOp(
        text=reference_word,
        center_x=center_x,
        baseline_y=baseline_y,
        font_size=font_size,
        color_rgb=color_rgb,
    )


def _effective_font_size(
    bbox_h: int,
    custom_font_size: float | None,
    style: AnnotationStyle,
) -> float:
    """Return the effective font size (SVG em-box pixels) for an annotation."""
    if custom_font_size is not None and custom_font_size > 0:
        return custom_font_size
    # Fallback: same formula as the frontend SVG default (bboxH * 0.5)
    # Note: the frontend also multiplies by annotationScale, but that value is
    # already baked into label_font_size by the frontend before sending.
    return max(min(round(bbox_h * 0.5), 48), 10)


def _compute_default_baseline_y(
    text: str,
    font_size: float,
    font_path: str | None,
    above_y: int,
    gap: int,
    y_offset: int,
) -> int:
    """Compute the text baseline Y for default (non-custom) label placement.

    The label is placed above *above_y* with a gap, matching the frontend SVG
    positioning logic.
    """
    if font_path:
        font = _get_pil_font(font_path, int(round(font_size)))
        ascent, _ = font.getmetrics()
    else:
        # Approximate ascent as ~80% of em-box
        ascent = int(font_size * 0.8)
    # Position: baseline such that text top = above_y - gap + y_offset - some padding
    # The SVG default is: y = bbox_y1 - 8*s + labelYOffset - fontSize/2
    # which places the baseline at approximately above_y - gap - ascent/2
    # Here we replicate that intent: bottom of text (baseline) sits above the gap
    return above_y - gap + y_offset


def _render_text_ops_pil(
    img: np.ndarray,
    text_ops: list[_TextOp],
    font_path: str,
) -> None:
    """Draw all collected text operations onto img using PIL TrueType rendering.

    Single BGR→RGB→PIL→draw→RGB→BGR conversion for all text ops.
    """
    pil_img = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
    draw = ImageDraw.Draw(pil_img)

    for op in text_ops:
        font = _get_pil_font(font_path, int(round(op.font_size)))
        # anchor="ms" = middle-horizontal, baseline-vertical
        draw.text(
            (op.center_x, op.baseline_y),
            op.text,
            font=font,
            fill=op.color_rgb,
            anchor="ms",
        )

    result = cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)
    np.copyto(img, result)


def _render_text_ops_cv2(
    img: np.ndarray,
    text_ops: list[_TextOp],
) -> None:
    """Fallback: draw text using OpenCV when no TrueType font is available."""
    for op in text_ops:
        font_scale = max(op.font_size / 30.0, 0.4)
        font_thick = max(round(font_scale * 1.5), 1)
        text_size = cv2.getTextSize(
            op.text, cv2.FONT_HERSHEY_SIMPLEX, font_scale, font_thick,
        )[0]
        text_x = op.center_x - text_size[0] // 2
        color_bgr = (op.color_rgb[2], op.color_rgb[1], op.color_rgb[0])
        cv2.putText(
            img, op.text, (text_x, op.baseline_y),
            cv2.FONT_HERSHEY_SIMPLEX, font_scale, color_bgr, font_thick,
            cv2.LINE_AA,
        )


def _has_valid_bbox(ann: dict) -> bool:
    """Check that annotation has a non-zero bounding box."""
    x1, y1 = ann.get("bbox_x1", 0), ann.get("bbox_y1", 0)
    x2, y2 = ann.get("bbox_x2", 0), ann.get("bbox_y2", 0)
    return (x2 - x1) > 1 and (y2 - y1) > 1


def _has_custom_label_position(ann: dict) -> bool:
    """Check if annotation has user-defined label positioning."""
    return ann.get("label_x") is not None and ann.get("label_y") is not None


def _compute_label_rect_from_annotation(
    img: np.ndarray,
    ann: dict,
    index: int,
    style: AnnotationStyle,
    font_path: str | None = None,
) -> LabelRect | None:
    """Compute the AABB of a label that would be drawn for an annotation dict.

    When *font_path* is provided, uses PIL TrueType font for measurement so
    that the rectangles match the actual PIL-rendered text.
    """
    reference_word = ann.get("reference_word")
    if not reference_word:
        return None

    error_type = ann.get("error_type", "")
    x1, y1 = int(ann["bbox_x1"]), int(ann["bbox_y1"])
    x2, y2 = int(ann["bbox_x2"]), int(ann["bbox_y2"])
    bbox_h = y2 - y1

    font_size = _effective_font_size(bbox_h, ann.get("label_font_size"), style)

    # Measure text extent
    if font_path:
        font = _get_pil_font(font_path, int(round(font_size)))
        bbox_text = font.getbbox(reference_word)
        text_w = bbox_text[2] - bbox_text[0]
        text_h = bbox_text[3] - bbox_text[1]
    else:
        # Fallback to OpenCV measurement
        fs = max(font_size / 30.0, 0.4)
        ft = max(round(fs * 1.5), 1)
        text_size = cv2.getTextSize(
            reference_word, cv2.FONT_HERSHEY_SIMPLEX, fs, ft,
        )[0]
        text_w, text_h = text_size

    # Custom label position
    custom_lx = ann.get("label_x")
    custom_ly = ann.get("label_y")
    if custom_lx is not None and custom_ly is not None:
        text_x = int(custom_lx) - text_w // 2
        text_y = int(custom_ly)
        return LabelRect(
            op_index=index,
            x=text_x,
            y=text_y - text_h,
            width=text_w,
            height=text_h,
        )

    cx = (x1 + x2) // 2

    if error_type == "wrong":
        text_x = cx - text_w // 2
        text_y = y1 - style.text_gap
        return LabelRect(
            op_index=index,
            x=text_x,
            y=text_y - text_h,
            width=text_w,
            height=text_h,
        )

    if error_type == "missing":
        caret_top = y2 - style.caret_size
        text_x = cx - text_w // 2
        text_y = caret_top - 4
        return LabelRect(
            op_index=index,
            x=text_x,
            y=text_y - text_h,
            width=text_w,
            height=text_h,
        )

    return None


def _draw_wrong_from_bbox(
    img: np.ndarray,
    bbox: tuple[int, int, int, int],
    reference_word: str | None,
    style: AnnotationStyle,
    label_y_offset: int = 0,
    label_x: float | None = None,
    label_y: float | None = None,
    label_font_size: float | None = None,
) -> None:
    """Draw red ellipse around bbox + reference word above."""
    x1, y1, x2, y2 = bbox
    cx = (x1 + x2) // 2
    cy = (y1 + y2) // 2
    bbox_h = y2 - y1
    w = (x2 - x1) // 2 + 6
    h = bbox_h // 2 + 4

    cv2.ellipse(img, (cx, cy), (w, h), 0, 0, 360, COLOR_WRONG, style.ellipse_thickness)

    if reference_word:
        if label_font_size is not None and label_font_size > 0:
            font_scale = max(label_font_size / 22.0, 0.4)
            font_thick = max(round(font_scale * 1.5), 1)
        else:
            font_scale, font_thick = _font_params_for_bbox(bbox_h, style)
        text_size = cv2.getTextSize(
            reference_word, cv2.FONT_HERSHEY_SIMPLEX, font_scale, font_thick,
        )[0]
        if label_x is not None and label_y is not None:
            # Custom position: label_x/y is center of text
            text_x = int(label_x) - text_size[0] // 2
            text_y = int(label_y) + text_size[1] // 2
        else:
            text_x = cx - text_size[0] // 2
            text_y = y1 - style.text_gap + label_y_offset
        cv2.putText(
            img, reference_word, (text_x, text_y),
            cv2.FONT_HERSHEY_SIMPLEX, font_scale, COLOR_WRONG, font_thick,
            cv2.LINE_AA,
        )


def _draw_extra_from_bbox(
    img: np.ndarray,
    bbox: tuple[int, int, int, int],
    style: AnnotationStyle,
) -> None:
    """Draw orange strikethrough across bbox."""
    x1, y1, x2, y2 = bbox
    cy = (y1 + y2) // 2
    cv2.line(img, (x1, cy), (x2, cy), COLOR_EXTRA, style.strikethrough_thickness)


def _draw_missing_from_bbox(
    img: np.ndarray,
    bbox: tuple[int, int, int, int],
    reference_word: str | None,
    style: AnnotationStyle,
    label_y_offset: int = 0,
    label_x: float | None = None,
    label_y: float | None = None,
    label_font_size: float | None = None,
) -> None:
    """Draw blue caret marker + reference word above."""
    x1, y1, x2, y2 = bbox
    cx = (x1 + x2) // 2
    bbox_h = y2 - y1

    # Caret symbol: fixed height of caret_size, bottom at bbox bottom
    caret_bottom = y2
    caret_top = caret_bottom - style.caret_size
    cv2.line(img, (cx - style.caret_size // 2, caret_bottom),
             (cx, caret_top), COLOR_MISSING, 2)
    cv2.line(img, (cx, caret_top),
             (cx + style.caret_size // 2, caret_bottom), COLOR_MISSING, 2)

    if reference_word:
        if label_font_size is not None and label_font_size > 0:
            font_scale = max(label_font_size / 22.0, 0.4)
            font_thick = max(round(font_scale * 1.5), 1)
        else:
            font_scale, font_thick = _font_params_for_bbox(bbox_h, style)
        text_size = cv2.getTextSize(
            reference_word, cv2.FONT_HERSHEY_SIMPLEX, font_scale, font_thick,
        )[0]
        if label_x is not None and label_y is not None:
            text_x = int(label_x) - text_size[0] // 2
            text_y = int(label_y) + text_size[1] // 2
        else:
            text_x = cx - text_size[0] // 2
            text_y = caret_top - 4 + label_y_offset
        cv2.putText(
            img, reference_word, (text_x, text_y),
            cv2.FONT_HERSHEY_SIMPLEX, font_scale, COLOR_MISSING, font_thick,
            cv2.LINE_AA,
        )
