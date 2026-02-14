"""Pydantic schemas for ImageRecord."""

from datetime import datetime

from pydantic import BaseModel

from app.models.image_record import ImageStatus


class OcrWord(BaseModel):
    text: str
    bbox: list[float]  # [x1, y1, x2, y2]
    confidence: float


class ImageResponse(BaseModel):
    id: int
    task_id: int
    label: str | None
    image_path: str
    annotated_image_path: str | None
    ocr_raw_text: str | None
    ocr_words: list[OcrWord] | None = None
    diff_result: list[dict] | None = None
    status: ImageStatus
    error_message: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


class ImageListItem(BaseModel):
    id: int
    task_id: int
    label: str | None
    sort_order: int
    status: ImageStatus
    error_message: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


class OcrCorrectionRequest(BaseModel):
    """Request body for correcting OCR text."""
    corrected_text: str


class ReorderRequest(BaseModel):
    """Request body for reordering images within a task."""
    image_ids: list[int]


class ImageUploadResponse(BaseModel):
    uploaded: int
    images: list[ImageListItem]
