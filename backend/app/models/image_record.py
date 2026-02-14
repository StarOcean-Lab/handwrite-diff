"""ImageRecord ORM model."""

import enum
from datetime import datetime, timezone

from sqlalchemy import DateTime, Enum, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class ImageStatus(str, enum.Enum):
    PENDING = "pending"
    OCR_PROCESSING = "ocr_processing"
    OCR_DONE = "ocr_done"
    DIFF_DONE = "diff_done"
    ANNOTATED = "annotated"
    REVIEWED = "reviewed"
    FAILED = "failed"


class ImageRecord(Base):
    __tablename__ = "image_records"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    task_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("comparison_tasks.id", ondelete="CASCADE"), nullable=False
    )
    label: Mapped[str | None] = mapped_column(String(255), nullable=True)
    image_path: Mapped[str] = mapped_column(String(512), nullable=False)
    annotated_image_path: Mapped[str | None] = mapped_column(String(512), nullable=True)
    ocr_raw_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    ocr_words_json: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON
    diff_result_json: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON
    status: Mapped[ImageStatus] = mapped_column(
        Enum(ImageStatus), default=ImageStatus.PENDING, nullable=False
    )
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        default=lambda: datetime.now(timezone.utc),
    )

    # Relationships
    task: Mapped["ComparisonTask"] = relationship(  # type: ignore[name-defined]  # noqa: F821
        "ComparisonTask", back_populates="images"
    )
    annotations: Mapped[list["WordAnnotation"]] = relationship(  # type: ignore[name-defined]  # noqa: F821
        "WordAnnotation", back_populates="image", cascade="all, delete-orphan"
    )
