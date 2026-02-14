"""Pydantic schemas for ComparisonTask."""

from datetime import datetime

from pydantic import BaseModel, Field

from app.models.comparison_task import TaskStatus


class TaskCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=255)
    reference_text: str = Field(..., min_length=1)
    ocr_model: str | None = None


class TaskResponse(BaseModel):
    id: int
    title: str
    reference_text: str
    reference_words: list[str] | None = None
    status: TaskStatus
    total_images: int
    completed_images: int
    ocr_model: str | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class TaskListResponse(BaseModel):
    id: int
    title: str
    reference_text_preview: str
    status: TaskStatus
    total_images: int
    completed_images: int
    ocr_model: str | None = None
    created_at: datetime


class TaskListPaginated(BaseModel):
    items: list[TaskListResponse]
    total: int
    page: int
    limit: int
