"""Bbox refinement — tighten OCR word bounding boxes using ink pixels.

Gemini returns coarse normalized bboxes; actual handwritten strokes occupy a
narrower region.  This module uses adaptive thresholding to locate ink pixels
and shrinks each bbox to the true ink extent within an expanded search region.
"""

import logging

import cv2
import numpy as np

from app.services.ocr_service import OcrWord

logger = logging.getLogger("handwrite_diff.bbox_refiner")

# Expansion factor when defining the ink-search region around the original bbox.
_PAD_RATIO: float = 0.2
# Minimum ink pixels required to trust the refined bbox.
_MIN_INK_PIXELS: int = 5
# Maximum area growth ratio; revert to original if exceeded.
_MAX_AREA_GROWTH: float = 1.5


def refine_word_bboxes(image_path: str, words: list[OcrWord]) -> list[OcrWord]:
    """Tighten each word bbox to its actual ink pixel extent.

    For each OcrWord, the algorithm:
    1. Expands the bbox by _PAD_RATIO to create a search region.
    2. Applies adaptive Gaussian thresholding (THRESH_BINARY_INV → ink=white).
    3. Finds the bounding rectangle of ink pixels inside the region.
    4. Falls back to the original bbox if too few pixels or area grows too much.

    Args:
        image_path: Path to the original (pre-OCR) image.
        words: List of OcrWord instances from the OCR step.

    Returns:
        A new list of OcrWord instances with refined (or original) bboxes.
        Never raises — any error falls back to the original word list.
    """
    try:
        img = cv2.imread(image_path)
        if img is None:
            logger.warning("bbox_refiner: cannot read %s", image_path)
            return words

        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        binary = cv2.adaptiveThreshold(
            gray, 255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY_INV,
            blockSize=15,
            C=8,
        )
        img_h, img_w = img.shape[:2]

        refined: list[OcrWord] = []
        for word in words:
            x1, y1, x2, y2 = (int(v) for v in word.bbox)
            if x2 - x1 < 2 or y2 - y1 < 2:
                refined.append(word)
                continue

            pad = max(4, int(max(x2 - x1, y2 - y1) * _PAD_RATIO))
            rx1 = max(0, x1 - pad)
            ry1 = max(0, y1 - pad)
            rx2 = min(img_w, x2 + pad)
            ry2 = min(img_h, y2 + pad)

            region = binary[ry1:ry2, rx1:rx2]
            ys, xs = np.where(region > 0)

            if len(xs) < _MIN_INK_PIXELS:
                refined.append(word)
                continue

            tx1 = rx1 + int(np.min(xs))
            ty1 = ry1 + int(np.min(ys))
            tx2 = rx1 + int(np.max(xs))
            ty2 = ry1 + int(np.max(ys))

            orig_area = max(1, (x2 - x1) * (y2 - y1))
            new_area = max(1, (tx2 - tx1) * (ty2 - ty1))

            if new_area > orig_area * _MAX_AREA_GROWTH:
                refined.append(word)
                continue

            refined.append(OcrWord(
                text=word.text,
                bbox=(float(tx1), float(ty1), float(tx2), float(ty2)),
                confidence=word.confidence,
            ))

        return refined

    except Exception:
        logger.exception("bbox_refiner failed for %s — using original bboxes", image_path)
        return words
