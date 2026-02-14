"""WordAnnotation ORM model."""

import enum

from sqlalchemy import Boolean, Enum, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class ErrorType(str, enum.Enum):
    CORRECT = "correct"
    WRONG = "wrong"
    MISSING = "missing"
    EXTRA = "extra"


class AnnotationShape(str, enum.Enum):
    ELLIPSE = "ellipse"
    UNDERLINE = "underline"
    CARET = "caret"


class WordAnnotation(Base):
    __tablename__ = "word_annotations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    image_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("image_records.id", ondelete="CASCADE"), nullable=False
    )
    word_index: Mapped[int | None] = mapped_column(Integer, nullable=True)
    ocr_word: Mapped[str | None] = mapped_column(String(255), nullable=True)
    reference_word: Mapped[str | None] = mapped_column(String(255), nullable=True)
    error_type: Mapped[ErrorType] = mapped_column(Enum(ErrorType), nullable=False)
    annotation_shape: Mapped[AnnotationShape] = mapped_column(
        Enum(AnnotationShape), default=AnnotationShape.ELLIPSE, nullable=False
    )
    bbox_x1: Mapped[float] = mapped_column(Float, default=0.0)
    bbox_y1: Mapped[float] = mapped_column(Float, default=0.0)
    bbox_x2: Mapped[float] = mapped_column(Float, default=0.0)
    bbox_y2: Mapped[float] = mapped_column(Float, default=0.0)
    is_auto: Mapped[bool] = mapped_column(Boolean, default=True)
    is_user_corrected: Mapped[bool] = mapped_column(Boolean, default=False)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Custom label positioning (None = use default computed position)
    label_x: Mapped[float | None] = mapped_column(Float, nullable=True, default=None)
    label_y: Mapped[float | None] = mapped_column(Float, nullable=True, default=None)
    label_font_size: Mapped[float | None] = mapped_column(Float, nullable=True, default=None)

    # Relationships
    image: Mapped["ImageRecord"] = relationship(  # type: ignore[name-defined]  # noqa: F821
        "ImageRecord", back_populates="annotations"
    )
