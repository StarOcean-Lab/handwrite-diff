"""Image preprocessing — auto deskew + CLAHE contrast enhancement.

Creates a temporary processed copy for OCR use only.
The original uploaded image is NEVER modified.
"""

import logging
import tempfile
from pathlib import Path

import cv2
import numpy as np

logger = logging.getLogger("handwrite_diff.preprocessing")


def preprocess_for_ocr(image_path: str) -> str:
    """Return a preprocessed copy of the image optimised for OCR.

    Applies deskew (Hough lines) and CLAHE contrast enhancement.
    The result is written to a sibling temp file; the **original file is
    never touched**.  The caller is responsible for deleting the returned
    temp file after OCR completes.

    If preprocessing fails for any reason, the original path is returned so
    the pipeline can continue with the unprocessed image.

    Args:
        image_path: Path to the original image (will not be modified).

    Returns:
        Path to the preprocessed temp file, or ``image_path`` on failure.
    """
    try:
        img = cv2.imread(image_path)
        if img is None:
            logger.warning("preprocessing: cannot read %s", image_path)
            return image_path

        # ------------------------------------------------------------------
        # Step 1: Deskew via Hough lines
        # ------------------------------------------------------------------
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        blurred = cv2.GaussianBlur(gray, (5, 5), 0)
        edges = cv2.Canny(blurred, 50, 150, apertureSize=3)
        lines = cv2.HoughLines(edges, 1, np.pi / 180, threshold=100)

        angle = 0.0
        if lines is not None:
            angles: list[float] = []
            for line in lines[:50]:
                theta = line[0][1]
                a = (theta - np.pi / 2) * 180.0 / np.pi
                if abs(a) < 45:
                    angles.append(a)
            if angles:
                angle = float(np.median(angles))

        if abs(angle) > 0.5:
            h, w = img.shape[:2]
            M = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
            img = cv2.warpAffine(
                img, M, (w, h),
                flags=cv2.INTER_LINEAR,
                borderMode=cv2.BORDER_REPLICATE,
            )
            logger.info("Deskewed %.1f° for OCR → %s", angle, Path(image_path).name)

        # ------------------------------------------------------------------
        # Step 2: CLAHE on LAB L-channel
        # ------------------------------------------------------------------
        lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
        l_ch, a_ch, b_ch = cv2.split(lab)
        clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
        l_ch = clahe.apply(l_ch)
        img = cv2.cvtColor(cv2.merge([l_ch, a_ch, b_ch]), cv2.COLOR_LAB2BGR)

        # Write to a temp file in the same directory (avoids cross-device moves)
        suffix = Path(image_path).suffix or ".jpg"
        fd, tmp_path = tempfile.mkstemp(suffix=suffix, dir=Path(image_path).parent)
        import os
        os.close(fd)
        cv2.imwrite(tmp_path, img)
        logger.debug("Preprocessed temp file: %s", tmp_path)
        return tmp_path

    except Exception:
        logger.exception("preprocessing failed for %s — using original", image_path)
        return image_path
