"""ComparisonTask ORM model."""

import enum
from datetime import datetime, timezone

from sqlalchemy import DateTime, Enum, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class TaskStatus(str, enum.Enum):
    CREATED = "created"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"


class ComparisonTask(Base):
    __tablename__ = "comparison_tasks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    reference_text: Mapped[str] = mapped_column(Text, nullable=False)
    reference_words: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON
    status: Mapped[TaskStatus] = mapped_column(
        Enum(TaskStatus), default=TaskStatus.CREATED, nullable=False
    )
    ocr_model: Mapped[str | None] = mapped_column(String(100), nullable=True)
    total_images: Mapped[int] = mapped_column(Integer, default=0)
    completed_images: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        default=lambda: datetime.now(timezone.utc),
    )
    provider_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("model_providers.id", ondelete="SET NULL"),
        nullable=True,
    )

    # Relationships
    images: Mapped[list["ImageRecord"]] = relationship(  # type: ignore[name-defined]  # noqa: F821
        "ImageRecord", back_populates="task", cascade="all, delete-orphan"
    )
    provider: Mapped["ModelProvider | None"] = relationship(  # type: ignore[name-defined]  # noqa: F821
        "ModelProvider", back_populates="tasks"
    )
