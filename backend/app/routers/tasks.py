"""Task management API routes."""

import io
import json
import re
import zipfile
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from app.deps import DB
from app.models.comparison_task import ComparisonTask, TaskStatus
from app.models.image_record import ImageRecord, ImageStatus
from app.models.model_provider import ModelProvider
from app.schemas.task import TaskCreate, TaskListPaginated, TaskListResponse, TaskResponse, TaskUpdate

router = APIRouter(prefix="/api/v1/tasks", tags=["tasks"])


def _normalize_words(text: str) -> list[str]:
    """Split reference text into a word list, preserving original punctuation and case.

    Punctuation stripping is deferred to diff-time via _normalize() in diff_engine,
    so that reference words stored in the DB and shown in the UI keep their original form.
    """
    return [w for w in text.split() if w]


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

    # Resolve effective model: explicit ocr_model > provider.default_model
    effective_model = body.ocr_model
    provider_name: str | None = None
    if body.provider_id is not None:
        provider = await db.get(ModelProvider, body.provider_id)
        if not provider:
            raise HTTPException(status_code=404, detail="Provider not found")
        provider_name = provider.name
        if not effective_model:
            effective_model = provider.default_model

    task = ComparisonTask(
        title=body.title,
        reference_text=cleaned_text,
        reference_words=json.dumps(ref_words),
        status=TaskStatus.CREATED,
        ocr_model=effective_model,
        provider_id=body.provider_id,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)
    return _to_response(task, provider_name=provider_name)


@router.get("", response_model=TaskListPaginated)
async def list_tasks(db: DB, page: int = 1, limit: int = 20) -> TaskListPaginated:
    """List all tasks with pagination."""
    offset = (page - 1) * limit

    count_result = await db.execute(select(func.count(ComparisonTask.id)))
    total = count_result.scalar_one()

    result = await db.execute(
        select(ComparisonTask)
        .options(selectinload(ComparisonTask.provider))
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
                provider_id=t.provider_id,
                provider_name=t.provider.name if t.provider else None,
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
    result = await db.execute(
        select(ComparisonTask)
        .options(selectinload(ComparisonTask.provider))
        .where(ComparisonTask.id == task_id)
    )
    task = result.scalars().first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return _to_response(task, provider_name=task.provider.name if task.provider else None)


@router.delete("/{task_id}", status_code=204)
async def delete_task(task_id: int, db: DB) -> None:
    """Delete a task and all associated data."""
    task = await db.get(ComparisonTask, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    await db.delete(task)
    await db.commit()


@router.patch("/{task_id}", response_model=TaskResponse)
async def update_reference_text(
    task_id: int,
    body: TaskUpdate,
    background_tasks: BackgroundTasks,
    db: DB,
) -> TaskResponse:
    """Update reference text and re-trigger diff+annotate for all OCR-complete images.

    Does not re-run OCR. Existing ocr_words_json data is reused;
    only the diff and annotation steps are repeated.
    """
    task = await db.get(ComparisonTask, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    cleaned_text = _extract_english_lines(body.reference_text)
    ref_words = _normalize_words(cleaned_text)
    task.reference_text = cleaned_text
    task.reference_words = json.dumps(ref_words)

    # Check if any images have passed the OCR stage (can be re-diffed immediately)
    result = await db.execute(
        select(ImageRecord)
        .where(ImageRecord.task_id == task_id)
        .where(ImageRecord.status.in_([
            ImageStatus.OCR_DONE,
            ImageStatus.DIFF_DONE,
            ImageStatus.ANNOTATED,
            ImageStatus.REVIEWED,
        ]))
        .limit(1)
    )
    has_ocr_images = result.scalars().first() is not None

    if has_ocr_images:
        task.status = TaskStatus.PROCESSING

    await db.commit()
    await db.refresh(task)

    if has_ocr_images:
        background_tasks.add_task(_run_rediff_task, task_id)

    return _to_response(task)


async def _run_rediff_task(task_id: int) -> None:
    """Background task: re-run concatenated diff+annotate after reference text update."""
    from app.database import async_session_factory
    from app.services.pipeline import ProcessingPipeline

    async with async_session_factory() as db:
        pipeline = ProcessingPipeline(db)
        await pipeline.rediff_task(task_id)


def _to_response(task: ComparisonTask, provider_name: str | None = None) -> TaskResponse:
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
        provider_id=task.provider_id,
        provider_name=provider_name,
        created_at=task.created_at,
    )


@router.get("/{task_id}/stats")
async def get_task_stats(task_id: int, db: DB) -> dict:
    """Aggregate diff_result_json to compute accuracy statistics.

    Reads existing JSON columns; no new DB fields required.
    Returns real-time counts of correct/wrong/missing/extra words and overall accuracy.
    """
    task = await db.get(ComparisonTask, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    result = await db.execute(
        select(ImageRecord)
        .where(ImageRecord.task_id == task_id)
        .where(ImageRecord.diff_result_json.isnot(None))
    )
    records = list(result.scalars().all())

    counts: dict[str, int] = {"correct": 0, "wrong": 0, "missing": 0, "extra": 0}
    for rec in records:
        for op in json.loads(rec.diff_result_json):
            dt = op.get("diff_type", "")
            if dt in counts:
                counts[dt] += 1

    total = sum(counts.values())
    accuracy = round(counts["correct"] / total * 100, 1) if total > 0 else 0.0

    return {
        "task_id": task_id,
        "total_words": total,
        "accuracy_pct": accuracy,
        **counts,
    }


@router.get("/{task_id}/export-zip")
async def export_task_zip(task_id: int, db: DB) -> StreamingResponse:
    """Download all annotated images for a task as a ZIP archive."""
    task = await db.get(ComparisonTask, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    result = await db.execute(
        select(ImageRecord)
        .where(ImageRecord.task_id == task_id)
        .where(ImageRecord.annotated_image_path.isnot(None))
        .order_by(ImageRecord.sort_order)
    )
    records = list(result.scalars().all())

    if not records:
        raise HTTPException(status_code=400, detail="No annotated images available")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for i, record in enumerate(records):
            path = Path(record.annotated_image_path)
            if path.exists():
                label = record.label or f"image_{record.id}"
                arcname = f"{i + 1:02d}_{label}.jpg"
                zf.write(path, arcname)
    buf.seek(0)

    safe_title = re.sub(r"[^\w\s\-]", "", task.title)[:50].strip()
    filename = f"annotated_{safe_title}_{task_id}.zip"

    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
