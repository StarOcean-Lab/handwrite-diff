"""Task management API routes."""

import json
import re

from fastapi import APIRouter, HTTPException
from sqlalchemy import func, select

from app.deps import DB
from app.models.comparison_task import ComparisonTask, TaskStatus
from app.schemas.task import TaskCreate, TaskListPaginated, TaskListResponse, TaskResponse

router = APIRouter(prefix="/api/v1/tasks", tags=["tasks"])


def _normalize_words(text: str) -> list[str]:
    """Normalize reference text into a word list (lowercase, strip punctuation edges)."""
    raw_words = text.split()
    result: list[str] = []
    for w in raw_words:
        cleaned = re.sub(r"^[^\w]+|[^\w]+$", "", w.lower())
        if cleaned:
            result.append(cleaned)
    return result


# CJK Unified Ideographs + common CJK ranges
_CJK_RE = re.compile(r"[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]")
# Lines that are just numbers (paragraph markers like "21", "22.")
_NUMBER_ONLY_RE = re.compile(r"^\d+[.\s]*$")


def _extract_english_lines(text: str) -> str:
    """Extract only English lines from mixed-language reference text.

    Filters out:
      - Blank lines
      - Lines that are purely numeric (paragraph numbers like "21", "22")
      - Lines containing CJK characters (Chinese/Japanese/Korean translations)
    """
    lines: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if _NUMBER_ONLY_RE.match(stripped):
            continue
        if _CJK_RE.search(stripped):
            continue
        lines.append(stripped)
    return "\n".join(lines)


@router.post("", response_model=TaskResponse, status_code=201)
async def create_task(body: TaskCreate, db: DB) -> TaskResponse:
    """Create a new comparison task with reference text."""
    cleaned_text = _extract_english_lines(body.reference_text)
    ref_words = _normalize_words(cleaned_text)
    task = ComparisonTask(
        title=body.title,
        reference_text=cleaned_text,
        reference_words=json.dumps(ref_words),
        status=TaskStatus.CREATED,
        ocr_model=body.ocr_model,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)
    return _to_response(task)


@router.get("", response_model=TaskListPaginated)
async def list_tasks(db: DB, page: int = 1, limit: int = 20) -> TaskListPaginated:
    """List all tasks with pagination."""
    offset = (page - 1) * limit

    count_result = await db.execute(select(func.count(ComparisonTask.id)))
    total = count_result.scalar_one()

    result = await db.execute(
        select(ComparisonTask)
        .order_by(ComparisonTask.created_at.desc())
        .offset(offset)
        .limit(limit)
    )
    tasks = result.scalars().all()

    return TaskListPaginated(
        items=[
            TaskListResponse(
                id=t.id,
                title=t.title,
                reference_text_preview=t.reference_text[:100] + ("..." if len(t.reference_text) > 100 else ""),
                status=t.status,
                total_images=t.total_images,
                completed_images=t.completed_images,
                ocr_model=t.ocr_model,
                created_at=t.created_at,
            )
            for t in tasks
        ],
        total=total,
        page=page,
        limit=limit,
    )


@router.get("/{task_id}", response_model=TaskResponse)
async def get_task(task_id: int, db: DB) -> TaskResponse:
    """Get task details by ID."""
    task = await db.get(ComparisonTask, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return _to_response(task)


@router.delete("/{task_id}", status_code=204)
async def delete_task(task_id: int, db: DB) -> None:
    """Delete a task and all associated data."""
    task = await db.get(ComparisonTask, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    await db.delete(task)
    await db.commit()


def _to_response(task: ComparisonTask) -> TaskResponse:
    ref_words = json.loads(task.reference_words) if task.reference_words else None
    return TaskResponse(
        id=task.id,
        title=task.title,
        reference_text=task.reference_text,
        reference_words=ref_words,
        status=task.status,
        total_images=task.total_images,
        completed_images=task.completed_images,
        ocr_model=task.ocr_model,
        created_at=task.created_at,
    )
