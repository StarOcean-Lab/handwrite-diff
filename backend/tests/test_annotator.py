"""Unit tests for the annotator service."""

import tempfile
from pathlib import Path

import cv2
import numpy as np
import pytest

from app.services.annotator import (
    AnnotationStyle,
    LabelRect,
    _rects_overlap,
    _resolve_label_overlaps,
    annotate_image,
)
from app.services.diff_engine import DiffOp, DiffType


def _create_test_image(width: int = 800, height: int = 200) -> str:
    """Create a temporary white image and return its path."""
    img = np.ones((height, width, 3), dtype=np.uint8) * 255
    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    cv2.imwrite(tmp.name, img)
    return tmp.name


class TestAnnotateImage:
    def test_basic_wrong_annotation(self) -> None:
        img_path = _create_test_image()
        output_path = tempfile.mktemp(suffix=".jpg")

        ocr_words = [
            {"text": "the", "bbox": [10, 50, 60, 80], "confidence": 0.9},
            {"text": "set", "bbox": [70, 50, 120, 80], "confidence": 0.8},
        ]
        diff_ops = [
            DiffOp(DiffType.CORRECT, 0, 0, "the", "the"),
            DiffOp(DiffType.WRONG, 1, 1, "set", "sat"),
        ]

        result = annotate_image(img_path, ocr_words, diff_ops, output_path)
        assert Path(result).exists()

        annotated = cv2.imread(result)
        assert annotated is not None
        assert annotated.shape[0] > 0

        # Cleanup
        Path(img_path).unlink(missing_ok=True)
        Path(output_path).unlink(missing_ok=True)

    def test_extra_annotation(self) -> None:
        img_path = _create_test_image()
        output_path = tempfile.mktemp(suffix=".jpg")

        ocr_words = [
            {"text": "the", "bbox": [10, 50, 60, 80], "confidence": 0.9},
            {"text": "extra", "bbox": [70, 50, 150, 80], "confidence": 0.7},
        ]
        diff_ops = [
            DiffOp(DiffType.CORRECT, 0, 0, "the", "the"),
            DiffOp(DiffType.EXTRA, 1, None, "extra", None),
        ]

        result = annotate_image(img_path, ocr_words, diff_ops, output_path)
        assert Path(result).exists()

        Path(img_path).unlink(missing_ok=True)
        Path(output_path).unlink(missing_ok=True)

    def test_missing_annotation(self) -> None:
        img_path = _create_test_image()
        output_path = tempfile.mktemp(suffix=".jpg")

        ocr_words = [
            {"text": "the", "bbox": [10, 50, 60, 80], "confidence": 0.9},
            {"text": "sat", "bbox": [150, 50, 210, 80], "confidence": 0.85},
        ]
        diff_ops = [
            DiffOp(DiffType.CORRECT, 0, 0, "the", "the"),
            DiffOp(DiffType.MISSING, None, 1, None, "cat"),
            DiffOp(DiffType.CORRECT, 1, 2, "sat", "sat"),
        ]

        result = annotate_image(img_path, ocr_words, diff_ops, output_path)
        assert Path(result).exists()

        Path(img_path).unlink(missing_ok=True)
        Path(output_path).unlink(missing_ok=True)

    def test_no_diffs_produces_clean_image(self) -> None:
        img_path = _create_test_image()
        output_path = tempfile.mktemp(suffix=".jpg")

        ocr_words = [{"text": "hello", "bbox": [10, 50, 80, 80], "confidence": 0.95}]
        diff_ops = [DiffOp(DiffType.CORRECT, 0, 0, "hello", "hello")]

        result = annotate_image(img_path, ocr_words, diff_ops, output_path)
        assert Path(result).exists()

        Path(img_path).unlink(missing_ok=True)
        Path(output_path).unlink(missing_ok=True)

    def test_invalid_image_path_raises(self) -> None:
        with pytest.raises(FileNotFoundError):
            annotate_image("/nonexistent.png", [], [], "/tmp/out.jpg")

    def test_custom_style(self) -> None:
        img_path = _create_test_image()
        output_path = tempfile.mktemp(suffix=".jpg")

        style = AnnotationStyle(ellipse_thickness=5, font_height_ratio=1.0)
        ocr_words = [{"text": "set", "bbox": [10, 50, 60, 80], "confidence": 0.8}]
        diff_ops = [DiffOp(DiffType.WRONG, 0, 0, "set", "sat")]

        result = annotate_image(img_path, ocr_words, diff_ops, output_path, style=style)
        assert Path(result).exists()

        Path(img_path).unlink(missing_ok=True)
        Path(output_path).unlink(missing_ok=True)

    def test_overlapping_wrong_labels_get_separated(self) -> None:
        """Two WRONG annotations at similar x positions should produce
        non-overlapping labels in the annotated image."""
        img_path = _create_test_image(width=800, height=400)
        output_path = tempfile.mktemp(suffix=".jpg")

        # Two words at very close x positions → labels will overlap without offset
        ocr_words = [
            {"text": "beg", "bbox": [100, 100, 160, 140], "confidence": 0.8},
            {"text": "sit", "bbox": [110, 100, 170, 140], "confidence": 0.8},
        ]
        diff_ops = [
            DiffOp(DiffType.WRONG, 0, 0, "beg", "bag"),
            DiffOp(DiffType.WRONG, 1, 1, "sit", "sat"),
        ]

        result = annotate_image(img_path, ocr_words, diff_ops, output_path)
        assert Path(result).exists()

        # We can't easily pixel-check separation, but verify no crash
        annotated = cv2.imread(result)
        assert annotated is not None
        assert annotated.shape[0] > 0

        Path(img_path).unlink(missing_ok=True)
        Path(output_path).unlink(missing_ok=True)


class TestRectsOverlap:
    """Unit tests for the AABB overlap predicate."""

    def test_overlapping_rects(self) -> None:
        a = LabelRect(op_index=0, x=10, y=10, width=50, height=20)
        b = LabelRect(op_index=1, x=30, y=15, width=50, height=20)
        assert _rects_overlap(a, 0, b, 0) is True

    def test_non_overlapping_rects(self) -> None:
        a = LabelRect(op_index=0, x=10, y=10, width=30, height=20)
        b = LabelRect(op_index=1, x=100, y=10, width=30, height=20)
        assert _rects_overlap(a, 0, b, 0) is False

    def test_overlap_resolved_by_offset(self) -> None:
        a = LabelRect(op_index=0, x=10, y=10, width=50, height=20)
        b = LabelRect(op_index=1, x=30, y=15, width=50, height=20)
        # Shift b upward by 30 px → no overlap
        assert _rects_overlap(a, 0, b, -30) is False

    def test_touching_rects_do_not_overlap(self) -> None:
        a = LabelRect(op_index=0, x=10, y=10, width=30, height=20)
        b = LabelRect(op_index=1, x=40, y=10, width=30, height=20)
        assert _rects_overlap(a, 0, b, 0) is False


class TestResolveLabelOverlaps:
    """Unit tests for the greedy label overlap resolver."""

    def test_no_overlaps_returns_empty(self) -> None:
        rects = [
            LabelRect(op_index=0, x=10, y=10, width=30, height=15),
            LabelRect(op_index=1, x=100, y=10, width=30, height=15),
        ]
        offsets = _resolve_label_overlaps(rects)
        assert offsets == {}

    def test_single_label_returns_empty(self) -> None:
        rects = [LabelRect(op_index=0, x=10, y=10, width=30, height=15)]
        offsets = _resolve_label_overlaps(rects)
        assert offsets == {}

    def test_two_overlapping_labels_resolve(self) -> None:
        rects = [
            LabelRect(op_index=0, x=10, y=50, width=60, height=15),
            LabelRect(op_index=1, x=30, y=52, width=60, height=15),
        ]
        offsets = _resolve_label_overlaps(rects)
        # At least one label should have a non-zero (negative) offset
        assert len(offsets) > 0
        for v in offsets.values():
            assert v < 0

    def test_three_overlapping_labels_all_resolve(self) -> None:
        rects = [
            LabelRect(op_index=0, x=10, y=50, width=60, height=15),
            LabelRect(op_index=1, x=20, y=52, width=60, height=15),
            LabelRect(op_index=2, x=30, y=54, width=60, height=15),
        ]
        offsets = _resolve_label_overlaps(rects)

        # Verify no remaining overlaps after applying offsets
        adjusted = [(r, offsets.get(r.op_index, 0)) for r in rects]
        for i in range(len(adjusted)):
            for j in range(i + 1, len(adjusted)):
                ri, oi = adjusted[i]
                rj, oj = adjusted[j]
                assert not _rects_overlap(ri, oi, rj, oj), (
                    f"Labels {ri.op_index} and {rj.op_index} still overlap "
                    f"after resolution"
                )
