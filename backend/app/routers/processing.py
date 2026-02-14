"""Processing control API routes (OCR trigger, progress, regenerate, export)."""

from fastapi import APIRouter, BackgroundTasks, HTTPException
from sqlalchemy import select

from app.deps import DB
from app.models.comparison_task import ComparisonTask, TaskStatus
from app.models.image_record import ImageRecord, ImageStatus

router = APIRouter(tags=["processing"])


@router.post("/api/v1/tasks/{task_id}/process")
async def trigger_processing(
    task_id: int,
    background_tasks: BackgroundTasks,
    db: DB,
) -> dict:
    """Trigger batch OCR processing for all pending images in a task."""
    task = await db.get(ComparisonTask, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    if task.status == TaskStatus.PROCESSING:
        raise HTTPException(status_code=409, detail="Task is already being processed")

    # Fetch pending images
    result = await db.execute(
        select(ImageRecord)
        .where(ImageRecord.task_id == task_id)
        .where(ImageRecord.status == ImageStatus.PENDING)
    )
    pending_images = result.scalars().all()
    if not pending_images:
        raise HTTPException(status_code=400, detail="No pending images to process")

    # Update task status
    task.status = TaskStatus.PROCESSING
    await db.commit()

    # Enqueue background processing
    image_ids = [img.id for img in pending_images]
    background_tasks.add_task(_run_pipeline, task_id, image_ids)

    return {
        "status": "processing",
        "task_id": task_id,
        "queued_images": len(image_ids),
    }


@router.get("/api/v1/tasks/{task_id}/progress")
async def get_progress(task_id: int, db: DB) -> dict:
    """Get processing progress for a task with per-image status details."""
    task = await db.get(ComparisonTask, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    # Fetch per-image statuses
    result = await db.execute(
        select(ImageRecord)
        .where(ImageRecord.task_id == task_id)
        .order_by(ImageRecord.sort_order)
    )
    records = result.scalars().all()

    image_statuses = [
        {
            "id": r.id,
            "label": r.label,
            "status": r.status.value,
            "error_message": r.error_message,
        }
        for r in records
    ]

    # Derive current processing phase from image statuses
    current_phase = _derive_phase(task.status.value, image_statuses)

    return {
        "task_id": task_id,
        "status": task.status.value,
        "total_images": task.total_images,
        "completed_images": task.completed_images,
        "current_phase": current_phase,
        "images": image_statuses,
    }


@router.post("/api/v1/images/{image_id}/regenerate")
async def regenerate_annotations(
    image_id: int,
    background_tasks: BackgroundTasks,
    db: DB,
) -> dict:
    """Re-run diff + annotate after OCR correction."""
    record = await db.get(ImageRecord, image_id)
    if not record:
        raise HTTPException(status_code=404, detail="Image not found")

    if not record.ocr_raw_text:
        raise HTTPException(status_code=400, detail="No OCR data to regenerate from")

    background_tasks.add_task(_run_regenerate, image_id)
    return {"status": "regenerating", "image_id": image_id}


@router.post("/api/v1/images/{image_id}/export")
async def export_annotated_image(image_id: int, db: DB) -> dict:
    """Render current annotations to a static image and return its path."""
    record = await db.get(ImageRecord, image_id)
    if not record:
        raise HTTPException(status_code=404, detail="Image not found")

    # Will be implemented in Phase 2 with annotator service
    if not record.annotated_image_path:
        raise HTTPException(status_code=400, detail="No annotated image available yet")

    return {
        "status": "ok",
        "image_id": image_id,
        "annotated_image_path": record.annotated_image_path,
    }


def _derive_phase(task_status: str, image_statuses: list[dict]) -> str:
    """Derive a human-readable processing phase from image statuses.

    Returns one of:
      - "created"    : not processing
      - "ocr"        : at least one image is in OCR
      - "diff"       : all OCR done, running diff
      - "annotating" : diff done, rendering annotations
      - "completed"  : all finished
      - "failed"     : task failed
    """
    if task_status in ("created", "completed", "failed"):
        return task_status

    statuses = {img["status"] for img in image_statuses}

    if "ocr_processing" in statuses or (
        "pending" in statuses and "ocr_done" in statuses
    ):
        return "ocr"

    # All OCR done but not all annotated → diff/annotate phase
    if statuses <= {"ocr_done", "diff_done", "annotated", "reviewed", "failed"}:
        if "ocr_done" in statuses or "diff_done" in statuses:
            return "diff"

    return "annotating"


async def _run_pipeline(task_id: int, image_ids: list[int]) -> None:
    """Background task: run full processing pipeline."""
    from app.database import async_session_factory
    from app.services.pipeline import ProcessingPipeline

    async with async_session_factory() as db:
        pipeline = ProcessingPipeline(db)
        await pipeline.process_task(task_id, image_ids)


async def _run_regenerate(image_id: int) -> None:
    """Background task: re-run concatenated diff + annotate for the entire task."""
    from app.database import async_session_factory
    from app.services.pipeline import ProcessingPipeline

    async with async_session_factory() as db:
        # Look up which task this image belongs to, then rediff at task level
        record = await db.get(ImageRecord, image_id)
        if not record:
            return
        pipeline = ProcessingPipeline(db)
        await pipeline.rediff_task(record.task_id)
