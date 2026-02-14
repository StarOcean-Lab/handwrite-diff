"""Image management API routes."""

import asyncio
import difflib
import json
import re
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import func as sa_func, select

from app.config import get_settings
from app.deps import DB
from app.models.comparison_task import ComparisonTask, TaskStatus
from app.models.image_record import ImageRecord, ImageStatus
from app.models.word_annotation import WordAnnotation
from app.schemas.annotation import (
    AnnotationBatchUpdate,
    AnnotationCreate,
    AnnotationResponse,
    ImageDetailResponse,
    RenderExportRequest,
)
from app.schemas.image import ImageListItem, ImageUploadResponse, OcrCorrectionRequest, ReorderRequest
from app.services.annotator import render_from_annotations

router = APIRouter(tags=["images"])


@router.post(
    "/api/v1/tasks/{task_id}/images",
    response_model=ImageUploadResponse,
    status_code=201,
)
async def upload_images(
    task_id: int,
    files: list[UploadFile],
    db: DB,
) -> ImageUploadResponse:
    """Upload one or more images for a task."""
    task = await db.get(ComparisonTask, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    settings = get_settings()
    settings.ensure_storage_dirs()

    # Determine starting sort_order (max existing + 1)
    max_order_result = await db.execute(
        select(sa_func.coalesce(sa_func.max(ImageRecord.sort_order), -1))
        .where(ImageRecord.task_id == task_id)
    )
    next_order = max_order_result.scalar_one() + 1

    created: list[ImageRecord] = []
    for idx, file in enumerate(files):
        ext = Path(file.filename or "img.png").suffix
        unique_name = f"{task_id}_{uuid.uuid4().hex}{ext}"
        save_path = settings.upload_dir / unique_name

        content = await file.read()
        save_path.write_bytes(content)

        record = ImageRecord(
            task_id=task_id,
            label=file.filename,
            image_path=str(save_path),
            sort_order=next_order + idx,
            status=ImageStatus.PENDING,
        )
        db.add(record)
        created.append(record)

    task.total_images += len(created)
    await db.commit()
    for r in created:
        await db.refresh(r)

    return ImageUploadResponse(
        uploaded=len(created),
        images=[
            ImageListItem(
                id=r.id,
                task_id=r.task_id,
                label=r.label,
                sort_order=r.sort_order,
                status=r.status,
                error_message=r.error_message,
                created_at=r.created_at,
            )
            for r in created
        ],
    )


@router.get("/api/v1/tasks/{task_id}/images", response_model=list[ImageListItem])
async def list_task_images(task_id: int, db: DB) -> list[ImageListItem]:
    """List all images for a given task, ordered by sort_order."""
    task = await db.get(ComparisonTask, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    result = await db.execute(
        select(ImageRecord)
        .where(ImageRecord.task_id == task_id)
        .order_by(ImageRecord.sort_order)
    )
    records = result.scalars().all()
    return [
        ImageListItem(
            id=r.id,
            task_id=r.task_id,
            label=r.label,
            sort_order=r.sort_order,
            status=r.status,
            error_message=r.error_message,
            created_at=r.created_at,
        )
        for r in records
    ]


@router.put("/api/v1/tasks/{task_id}/images/reorder")
async def reorder_images(
    task_id: int,
    body: ReorderRequest,
    background_tasks: BackgroundTasks,
    db: DB,
) -> dict:
    """Reorder images within a task. Triggers rediff if all images have completed OCR."""
    task = await db.get(ComparisonTask, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    if task.status == TaskStatus.PROCESSING:
        raise HTTPException(status_code=409, detail="Cannot reorder while task is processing")

    # Fetch all images for this task
    result = await db.execute(
        select(ImageRecord).where(ImageRecord.task_id == task_id)
    )
    records = result.scalars().all()
    records_by_id = {r.id: r for r in records}

    # Validate: image_ids must cover all images exactly
    if set(body.image_ids) != set(records_by_id.keys()):
        raise HTTPException(
            status_code=400,
            detail="image_ids must contain exactly all image IDs for this task",
        )

    # Update sort_order
    for new_order, image_id in enumerate(body.image_ids):
        records_by_id[image_id].sort_order = new_order
    await db.commit()

    # Check if all images have completed OCR — trigger rediff if so
    all_ocr_done = all(
        r.status in (ImageStatus.OCR_DONE, ImageStatus.DIFF_DONE, ImageStatus.ANNOTATED, ImageStatus.REVIEWED)
        for r in records
    )
    triggered_rediff = False
    if all_ocr_done and len(records) > 0:
        task.status = TaskStatus.PROCESSING
        await db.commit()
        background_tasks.add_task(_run_rediff, task_id)
        triggered_rediff = True

    return {
        "status": "ok",
        "reordered": len(body.image_ids),
        "triggered_rediff": triggered_rediff,
    }


async def _run_rediff(task_id: int) -> None:
    """Background task: re-run concatenated diff + annotate for all images."""
    from app.database import async_session_factory
    from app.services.pipeline import ProcessingPipeline

    async with async_session_factory() as db:
        pipeline = ProcessingPipeline(db)
        await pipeline.rediff_task(task_id)


def _normalize_word(s: str) -> str:
    """Lowercase and strip leading/trailing non-word characters."""
    return re.sub(r"^[^\w]+|[^\w]+$", "", s.lower())


def _rebuild_ocr_words(
    old_words: list[dict],
    new_texts: list[str],
) -> list[dict]:
    """Rebuild OCR words list from corrected text, preserving bboxes via alignment.

    Uses SequenceMatcher to align old and new word lists so bounding boxes
    are carried over for unchanged words.  New / replaced words get a zero bbox.
    """
    old_texts = [w.get("text", "") for w in old_words]

    norm_old = [_normalize_word(t) for t in old_texts]
    norm_new = [_normalize_word(t) for t in new_texts]

    matcher = difflib.SequenceMatcher(None, norm_old, norm_new, autojunk=False)
    result: list[dict] = []

    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for offset in range(i2 - i1):
                entry = dict(old_words[i1 + offset])
                entry["text"] = new_texts[j1 + offset]
                result.append(entry)
        elif tag == "replace":
            old_len = i2 - i1
            new_len = j2 - j1
            for k in range(max(old_len, new_len)):
                if k < new_len:
                    if k < old_len:
                        # Reuse old bbox for positionally-matched replacement
                        entry = dict(old_words[i1 + k])
                        entry["text"] = new_texts[j1 + k]
                    else:
                        entry = {"text": new_texts[j1 + k], "bbox": [0, 0, 0, 0], "confidence": 0.5}
                    result.append(entry)
            # tag == "delete" portion (k >= new_len): old words dropped
        elif tag == "insert":
            for idx in range(j1, j2):
                result.append({"text": new_texts[idx], "bbox": [0, 0, 0, 0], "confidence": 0.5})
        # tag == "delete": old words removed entirely — nothing to add

    return result


@router.get("/api/v1/images/{image_id}", response_model=ImageDetailResponse)
async def get_image_detail(image_id: int, db: DB) -> ImageDetailResponse:
    """Get full image details including OCR data and annotations."""
    record = await db.get(ImageRecord, image_id)
    if not record:
        raise HTTPException(status_code=404, detail="Image not found")

    result = await db.execute(
        select(WordAnnotation)
        .where(WordAnnotation.image_id == image_id)
        .order_by(WordAnnotation.id)
    )
    annotations = result.scalars().all()

    return ImageDetailResponse(
        id=record.id,
        task_id=record.task_id,
        label=record.label,
        image_path=record.image_path,
        annotated_image_path=record.annotated_image_path,
        ocr_raw_text=record.ocr_raw_text,
        ocr_words=json.loads(record.ocr_words_json) if record.ocr_words_json else None,
        diff_result=json.loads(record.diff_result_json) if record.diff_result_json else None,
        status=record.status.value,
        error_message=record.error_message,
        annotations=[AnnotationResponse.model_validate(a) for a in annotations],
    )


@router.get("/api/v1/images/{image_id}/original")
async def get_original_image(image_id: int, db: DB) -> FileResponse:
    """Serve the original uploaded image."""
    record = await db.get(ImageRecord, image_id)
    if not record:
        raise HTTPException(status_code=404, detail="Image not found")
    path = Path(record.image_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Image file not found on disk")
    return FileResponse(path)


@router.get("/api/v1/images/{image_id}/annotated")
async def get_annotated_image(image_id: int, db: DB) -> FileResponse:
    """Serve the annotated image."""
    record = await db.get(ImageRecord, image_id)
    if not record or not record.annotated_image_path:
        raise HTTPException(status_code=404, detail="Annotated image not found")
    path = Path(record.annotated_image_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Annotated image file not found on disk")
    return FileResponse(path)


@router.patch("/api/v1/images/{image_id}/ocr")
async def correct_ocr_text(
    image_id: int,
    body: OcrCorrectionRequest,
    background_tasks: BackgroundTasks,
    db: DB,
) -> dict:
    """Correct OCR recognized text for an image and trigger rediff."""
    record = await db.get(ImageRecord, image_id)
    if not record:
        raise HTTPException(status_code=404, detail="Image not found")

    # 1. Update raw text
    record.ocr_raw_text = body.corrected_text

    # 2. Rebuild ocr_words_json — preserve bboxes for unchanged words
    old_words_data: list[dict] = json.loads(record.ocr_words_json) if record.ocr_words_json else []
    new_word_texts = body.corrected_text.split()
    record.ocr_words_json = json.dumps(
        _rebuild_ocr_words(old_words_data, new_word_texts)
    )

    # 3. Mark task as processing
    task = await db.get(ComparisonTask, record.task_id)
    if task:
        task.status = TaskStatus.PROCESSING
    await db.commit()

    # 4. Trigger full rediff (diff + annotations + annotated image) in background
    background_tasks.add_task(_run_rediff, record.task_id)

    return {"status": "ok", "message": "OCR text corrected, rediffing..."}


@router.put("/api/v1/images/{image_id}/annotations", response_model=list[AnnotationResponse])
async def replace_annotations(
    image_id: int,
    body: AnnotationBatchUpdate,
    db: DB,
) -> list[AnnotationResponse]:
    """Replace all annotations for an image."""
    record = await db.get(ImageRecord, image_id)
    if not record:
        raise HTTPException(status_code=404, detail="Image not found")

    # Delete existing annotations
    existing = await db.execute(
        select(WordAnnotation).where(WordAnnotation.image_id == image_id)
    )
    for a in existing.scalars().all():
        await db.delete(a)

    # Create new annotations
    new_annotations: list[WordAnnotation] = []
    for item in body.annotations:
        annotation = WordAnnotation(
            image_id=image_id,
            **item.model_dump(),
        )
        db.add(annotation)
        new_annotations.append(annotation)

    await db.commit()
    for a in new_annotations:
        await db.refresh(a)
    return [AnnotationResponse.model_validate(a) for a in new_annotations]


@router.post(
    "/api/v1/images/{image_id}/annotations",
    response_model=AnnotationResponse,
    status_code=201,
)
async def create_annotation(
    image_id: int,
    body: AnnotationCreate,
    db: DB,
) -> AnnotationResponse:
    """Add a single manual annotation."""
    record = await db.get(ImageRecord, image_id)
    if not record:
        raise HTTPException(status_code=404, detail="Image not found")

    annotation = WordAnnotation(image_id=image_id, **body.model_dump())
    db.add(annotation)
    await db.commit()
    await db.refresh(annotation)
    return AnnotationResponse.model_validate(annotation)


@router.delete("/api/v1/images/{image_id}/annotations/{annot_id}", status_code=204)
async def delete_annotation(image_id: int, annot_id: int, db: DB) -> None:
    """Delete a single annotation."""
    annotation = await db.get(WordAnnotation, annot_id)
    if not annotation or annotation.image_id != image_id:
        raise HTTPException(status_code=404, detail="Annotation not found")
    await db.delete(annotation)
    await db.commit()


@router.post("/api/v1/images/{image_id}/render-export")
async def render_export(
    image_id: int,
    body: RenderExportRequest,
    db: DB,
) -> FileResponse:
    """Render annotations onto the original image and return as a downloadable file.

    Accepts user-modified annotation positions and a scale_factor that controls
    the visual weight (line thickness, font size) of the rendered annotations.
    """
    record = await db.get(ImageRecord, image_id)
    if not record:
        raise HTTPException(status_code=404, detail="Image not found")

    original_path = Path(record.image_path)
    if not original_path.exists():
        raise HTTPException(status_code=404, detail="Original image file not found on disk")

    # Ensure exports directory exists
    settings = get_settings()
    exports_dir = settings.storage_dir / "exports"
    exports_dir.mkdir(parents=True, exist_ok=True)

    # Clean up old export files (> 1 hour), tolerating concurrent access
    _cleanup_old_exports(exports_dir)

    # Render in a thread to avoid blocking the event loop (CPU-intensive OpenCV)
    export_filename = f"export_{image_id}_{uuid.uuid4().hex}.jpg"
    export_path = exports_dir / export_filename

    annotation_dicts = [ann.model_dump() for ann in body.annotations]
    await asyncio.to_thread(
        render_from_annotations,
        image_path=str(original_path),
        annotations=annotation_dicts,
        scale_factor=body.scale_factor,
        output_path=str(export_path),
    )

    # Sanitize label for safe Content-Disposition filename
    safe_label = re.sub(r"[^\w\s\-.]", "_", record.label or str(image_id))
    download_name = f"annotated_{safe_label}.jpg"
    return FileResponse(
        path=str(export_path),
        media_type="image/jpeg",
        filename=download_name,
    )


def _cleanup_old_exports(exports_dir: Path, max_age_seconds: int = 3600) -> None:
    """Remove export files older than *max_age_seconds*. Safe under concurrency."""
    try:
        now = time.time()
        for old_file in exports_dir.iterdir():
            try:
                if old_file.is_file() and (now - old_file.stat().st_mtime) > max_age_seconds:
                    old_file.unlink(missing_ok=True)
            except OSError:
                continue
    except OSError:
        pass
