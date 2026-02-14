"""Pydantic schemas for WordAnnotation."""

from pydantic import BaseModel, Field

from app.models.word_annotation import AnnotationShape, ErrorType


class AnnotationCreate(BaseModel):
    word_index: int | None = None
    ocr_word: str | None = None
    reference_word: str | None = None
    error_type: ErrorType
    annotation_shape: AnnotationShape = AnnotationShape.ELLIPSE
    bbox_x1: float = 0.0
    bbox_y1: float = 0.0
    bbox_x2: float = 0.0
    bbox_y2: float = 0.0
    is_auto: bool = False
    note: str | None = None
    label_x: float | None = None
    label_y: float | None = None
    label_font_size: float | None = None


class AnnotationResponse(BaseModel):
    id: int
    image_id: int
    word_index: int | None
    ocr_word: str | None
    reference_word: str | None
    error_type: ErrorType
    annotation_shape: AnnotationShape
    bbox_x1: float
    bbox_y1: float
    bbox_x2: float
    bbox_y2: float
    is_auto: bool
    is_user_corrected: bool
    note: str | None
    label_x: float | None
    label_y: float | None
    label_font_size: float | None

    model_config = {"from_attributes": True}


class AnnotationBatchUpdate(BaseModel):
    """Full replacement of all annotations for an image."""
    annotations: list[AnnotationCreate]


class RenderExportRequest(BaseModel):
    """Request body for custom annotation rendering / export."""
    annotations: list[AnnotationCreate] = Field(max_length=1000)
    scale_factor: float = Field(default=1.0, ge=0.3, le=3.0)


class ImageDetailResponse(BaseModel):
    """Full image detail including annotations."""
    id: int
    task_id: int
    label: str | None
    image_path: str
    annotated_image_path: str | None
    ocr_raw_text: str | None
    ocr_words: list[dict] | None = None
    diff_result: list[dict] | None = None
    status: str
    error_message: str | None
    annotations: list[AnnotationResponse]

    model_config = {"from_attributes": True}
