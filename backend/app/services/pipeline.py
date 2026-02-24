"""Processing pipeline — orchestrates OCR → Diff → Annotate → Save.

Two-phase approach:
  Phase 1 (per-image): OCR only — extract words from each image independently.
  Phase 2 (task-level): Concatenate all OCR words in sort_order, run a single
      diff against reference text, split results back to individual images,
      create annotations and render annotated images.

Designed for BackgroundTasks execution. Each step updates image status
so the frontend can poll progress.
"""

import asyncio
import json
import logging
import uuid
from dataclasses import asdict

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models.comparison_task import ComparisonTask, TaskStatus
from app.models.image_record import ImageRecord, ImageStatus
from app.models.word_annotation import AnnotationShape, ErrorType, WordAnnotation
from app.services.annotator import annotate_image
from app.services.bbox_refiner import refine_word_bboxes
from app.services.diff_engine import DiffOp, DiffType, compute_word_diff, normalize_word_list
from app.services.ocr_service import OcrResult, ProviderConfig, run_ocr
from app.services.preprocessing import preprocess_for_ocr

logger = logging.getLogger("handwrite_diff.pipeline")


class ProcessingPipeline:
    """Orchestrates the full OCR → concatenated Diff → Annotate pipeline."""

    def __init__(self, db: AsyncSession) -> None:
        self._db = db

    # ------------------------------------------------------------------
    # Public entry points
    # ------------------------------------------------------------------

    async def process_task(self, task_id: int, image_ids: list[int]) -> None:
        """Process all queued images for a task (full pipeline).

        Phase 1: Run OCR on each image independently.
        Phase 2: Concatenate OCR results and run a single diff + annotate.
        """
        task = await self._db.get(ComparisonTask, task_id)
        if not task:
            logger.error("Task %d not found", task_id)
            return

        ref_words = (
            json.loads(task.reference_words)
            if task.reference_words
            else normalize_word_list(task.reference_text)
        )

        # Build provider config if the task has a provider_id
        provider_config: ProviderConfig | None = None
        if task.provider_id is not None:
            from app.models.model_provider import ModelProvider
            provider = await self._db.get(ModelProvider, task.provider_id)
            if provider:
                base_url = provider.base_url.rstrip("/")
                if not base_url.endswith("/v1"):
                    base_url += "/v1"
                provider_config = ProviderConfig(
                    base_url=base_url,
                    api_key=provider.api_key,
                    model=provider.default_model,
                )

        # Phase 1: OCR each image
        ocr_model = task.ocr_model
        for image_id in image_ids:
            try:
                await self._run_ocr_only(image_id, model=ocr_model, provider_config=provider_config)
                task.completed_images += 1
                await self._db.commit()
            except Exception:
                logger.exception("Failed OCR for image %d", image_id)
                await self._mark_image_failed(image_id, "OCR pipeline error")

        # Phase 2: Concatenated diff + annotate (task-level)
        try:
            await self._run_concatenated_diff_and_annotate(task_id, ref_words)
        except Exception:
            logger.exception("Failed concatenated diff for task %d", task_id)

        # Update task status
        await self._db.refresh(task)
        result = await self._db.execute(
            select(ImageRecord)
            .where(ImageRecord.task_id == task_id)
            .where(ImageRecord.status == ImageStatus.FAILED)
        )
        has_failures = result.scalars().first() is not None

        if has_failures:
            task.status = TaskStatus.FAILED
        else:
            task.status = TaskStatus.COMPLETED
        await self._db.commit()

    async def rediff_task(self, task_id: int) -> None:
        """Re-run concatenated diff + annotate for a task (skip OCR).

        Called after reordering images or after OCR correction.
        """
        task = await self._db.get(ComparisonTask, task_id)
        if not task:
            logger.error("Task %d not found for rediff", task_id)
            return

        ref_words = (
            json.loads(task.reference_words)
            if task.reference_words
            else normalize_word_list(task.reference_text)
        )

        try:
            await self._run_concatenated_diff_and_annotate(task_id, ref_words)
            task.status = TaskStatus.COMPLETED
        except Exception:
            logger.exception("Rediff failed for task %d", task_id)
            task.status = TaskStatus.FAILED
        await self._db.commit()

    # ------------------------------------------------------------------
    # Phase 1: Per-image OCR
    # ------------------------------------------------------------------

    async def _run_ocr_only(
        self,
        image_id: int,
        model: str | None = None,
        provider_config: ProviderConfig | None = None,
    ) -> None:
        """Run OCR on a single image and store results."""
        record = await self._db.get(ImageRecord, image_id)
        if not record:
            return

        record.status = ImageStatus.OCR_PROCESSING
        await self._db.commit()

        # Step 0: preprocess into a temp file — original is never touched
        ocr_path = await asyncio.to_thread(preprocess_for_ocr, record.image_path)
        try:
            ocr_result: OcrResult = await run_ocr(
                ocr_path, model=model, provider_config=provider_config
            )

            # Refine bboxes on the preprocessed image (same pixel space)
            refined_words = await asyncio.to_thread(refine_word_bboxes, ocr_path, ocr_result.words)
        finally:
            # Always clean up the temp file; silently ignore missing-file errors
            if ocr_path != record.image_path:
                try:
                    import os as _os
                    _os.unlink(ocr_path)
                except OSError:
                    pass

        ocr_words_data = [
            {"text": w.text, "bbox": list(w.bbox), "confidence": w.confidence}
            for w in refined_words
        ]
        record.ocr_raw_text = ocr_result.raw_text
        record.ocr_words_json = json.dumps(ocr_words_data)
        record.status = ImageStatus.OCR_DONE
        await self._db.commit()

    # ------------------------------------------------------------------
    # Phase 2: Concatenated diff + annotate (task-level)
    # ------------------------------------------------------------------

    async def _run_concatenated_diff_and_annotate(
        self,
        task_id: int,
        ref_words: list[str],
    ) -> None:
        """Concatenate all OCR words by sort_order, diff once, split back."""
        # Fetch all images that have successful OCR, sorted by sort_order
        result = await self._db.execute(
            select(ImageRecord)
            .where(ImageRecord.task_id == task_id)
            .where(
                ImageRecord.status.in_([
                    ImageStatus.OCR_DONE,
                    ImageStatus.DIFF_DONE,
                    ImageStatus.ANNOTATED,
                    ImageStatus.REVIEWED,
                ])
            )
            .order_by(ImageRecord.sort_order)
        )
        records = list(result.scalars().all())

        if not records:
            logger.warning("No OCR-complete images for task %d", task_id)
            return

        # Build concatenated word list and track per-image offsets
        concatenated_words: list[str] = []
        # List of (image_record, ocr_words_data, start_offset, end_offset)
        image_slices: list[tuple[ImageRecord, list[dict], int, int]] = []

        for record in records:
            ocr_words_data = json.loads(record.ocr_words_json) if record.ocr_words_json else []
            word_texts = [w["text"] for w in ocr_words_data]
            start = len(concatenated_words)
            concatenated_words.extend(word_texts)
            end = len(concatenated_words)
            image_slices.append((record, ocr_words_data, start, end))

        # Single diff on full concatenated text
        all_diff_ops = compute_word_diff(concatenated_words, ref_words)

        # Split diff ops back to each image and process
        for record, ocr_words_data, start, end in image_slices:
            try:
                image_ops = _split_diff_ops_for_image(all_diff_ops, start, end)

                # ── Preserve user-corrected annotations ──
                existing_q = await self._db.execute(
                    select(WordAnnotation).where(WordAnnotation.image_id == record.id)
                )
                existing_annotations = existing_q.scalars().all()

                # Collect user corrections keyed by word_index (ocr_index)
                user_corrections: dict[int | None, WordAnnotation] = {}
                for a in existing_annotations:
                    if a.is_user_corrected:
                        user_corrections[a.word_index] = a

                if user_corrections:
                    logger.info(
                        "Image %d: loaded %d user corrections: %s",
                        record.id, len(user_corrections),
                        {k: (v.ocr_word, v.reference_word, v.error_type.value,
                             f"bbox=({v.bbox_x1:.0f},{v.bbox_y1:.0f},{v.bbox_x2:.0f},{v.bbox_y2:.0f})")
                         for k, v in user_corrections.items()},
                    )

                # Apply user corrections to diff ops for this image
                if user_corrections:
                    image_ops = _apply_user_corrections(image_ops, user_corrections)

                # Store per-image diff result (hidden members keep original ref_word
                # so the frontend re-pairing pass can display orphaned refs correctly)
                ops_serialized = []
                for op in image_ops:
                    d = asdict(op)
                    if op.ocr_index is not None and op.ocr_index < len(ocr_words_data):
                        d["ocr_confidence"] = ocr_words_data[op.ocr_index].get("confidence")
                    else:
                        d["ocr_confidence"] = None
                    ops_serialized.append(d)
                record.diff_result_json = json.dumps(ops_serialized)
                record.status = ImageStatus.DIFF_DONE

                # Apply merge re-pairing for annotation rendering: suppress hidden
                # members and re-pair orphaned ref words with subsequent EXTRA ops,
                # mirroring the frontend computeDisplayDiffOps re-pairing pass so
                # the annotated image matches the diff display.
                annotate_ops = (
                    _apply_merge_repairing(image_ops, user_corrections)
                    if user_corrections
                    else image_ops
                )

                # Delete old annotations
                for a in existing_annotations:
                    await self._db.delete(a)

                # Create new annotations (using re-paired ops for accurate visual annotation)
                self._create_annotations(record.id, ocr_words_data, annotate_ops,
                                         user_corrections)

                # Build ocr_words copy with merged bboxes for annotation rendering
                annotate_ocr_words = list(ocr_words_data)
                if user_corrections:
                    annotate_ocr_words = [dict(w) for w in ocr_words_data]
                    for uc_idx, uc in user_corrections.items():
                        if (uc_idx is not None and uc_idx < len(annotate_ocr_words)
                                and (uc.bbox_x2 - uc.bbox_x1) > 1
                                and (uc.bbox_y2 - uc.bbox_y1) > 1):
                            annotate_ocr_words[uc_idx] = {
                                **annotate_ocr_words[uc_idx],
                                "bbox": [uc.bbox_x1, uc.bbox_y1, uc.bbox_x2, uc.bbox_y2],
                            }

                # Render annotated image (using re-paired ops)
                await self._annotate_static_image(record, annotate_ocr_words, annotate_ops)
                record.status = ImageStatus.ANNOTATED

                await self._db.commit()  # 单次原子提交

            except Exception:
                logger.exception("Failed diff/annotate for image %d", record.id)
                await self._db.rollback()
                await self._mark_image_failed(record.id, "Diff/annotate pipeline error")

    # ------------------------------------------------------------------
    # Shared helpers
    # ------------------------------------------------------------------

    def _create_annotations(
        self,
        image_id: int,
        ocr_words_data: list[dict],
        diff_ops: list[DiffOp],
        user_corrections: dict[int | None, "WordAnnotation"] | None = None,
    ) -> None:
        """Create WordAnnotation ORM records from diff operations.

        If *user_corrections* is provided, annotations matching a user-corrected
        word_index will inherit the ``is_user_corrected`` flag so the correction
        survives future rediff cycles.
        """
        if user_corrections is None:
            user_corrections = {}

        for op in diff_ops:
            if op.diff_type == DiffType.CORRECT:
                # Still create annotation for user-corrected "correct" entries
                # so the correction flag is preserved
                if op.ocr_index not in user_corrections:
                    continue

            # Determine bbox — prefer user-corrected bbox (merged words have union bbox)
            bbox = (0.0, 0.0, 0.0, 0.0)
            uc = user_corrections.get(op.ocr_index)
            if uc is not None and (uc.bbox_x2 - uc.bbox_x1) > 1 and (uc.bbox_y2 - uc.bbox_y1) > 1:
                bbox = (uc.bbox_x1, uc.bbox_y1, uc.bbox_x2, uc.bbox_y2)
            elif op.ocr_index is not None and op.ocr_index < len(ocr_words_data):
                b = ocr_words_data[op.ocr_index]["bbox"]
                bbox = (b[0], b[1], b[2], b[3])
            elif op.diff_type == DiffType.MISSING:
                bbox = _infer_missing_bbox(ocr_words_data, diff_ops, op)

            # Map diff type to annotation shape
            shape_map = {
                DiffType.WRONG: AnnotationShape.ELLIPSE,
                DiffType.EXTRA: AnnotationShape.UNDERLINE,
                DiffType.MISSING: AnnotationShape.CARET,
            }

            # Preserve user correction metadata (label position, font size, etc.)
            is_corrected = op.ocr_index in user_corrections
            # uc already retrieved above for bbox determination

            annotation = WordAnnotation(
                image_id=image_id,
                word_index=op.ocr_index,
                ocr_word=op.ocr_word,
                reference_word=op.reference_word,
                error_type=ErrorType(op.diff_type.value),
                annotation_shape=shape_map.get(op.diff_type, AnnotationShape.ELLIPSE),
                bbox_x1=bbox[0],
                bbox_y1=bbox[1],
                bbox_x2=bbox[2],
                bbox_y2=bbox[3],
                is_auto=True,
                is_user_corrected=is_corrected,
                label_x=uc.label_x if uc else None,
                label_y=uc.label_y if uc else None,
                label_font_size=uc.label_font_size if uc else None,
            )
            self._db.add(annotation)

    async def _annotate_static_image(
        self,
        record: ImageRecord,
        ocr_words_data: list[dict],
        diff_ops: list[DiffOp],
    ) -> None:
        """Render annotations onto original image and save."""
        settings = get_settings()
        settings.ensure_storage_dirs()

        output_name = f"{record.task_id}_{record.id}_{uuid.uuid4().hex[:8]}.jpg"
        output_path = str(settings.annotated_dir / output_name)

        await asyncio.to_thread(
            annotate_image,
            image_path=record.image_path,
            ocr_words=ocr_words_data,
            diff_ops=diff_ops,
            output_path=output_path,
        )
        record.annotated_image_path = output_path

    async def _mark_image_failed(self, image_id: int, message: str) -> None:
        """Mark an image as failed with error message."""
        record = await self._db.get(ImageRecord, image_id)
        if record:
            record.status = ImageStatus.FAILED
            record.error_message = message
            await self._db.commit()


# ------------------------------------------------------------------
# Module-level helper: infer bbox for MISSING words
# ------------------------------------------------------------------

def _infer_missing_bbox(
    ocr_words_data: list[dict],
    diff_ops: list[DiffOp],
    target_op: DiffOp,
) -> tuple[float, float, float, float]:
    """Infer a plausible bbox for a MISSING word from its neighbouring OCR words.

    Strategy:
      - Find the nearest preceding and following ops that have an ``ocr_index``
        pointing to a valid OCR word.
      - Use the gap between the preceding word's right edge and the following
        word's left edge as the horizontal extent.
      - Vertical extent is taken from the neighbour's bbox.
      - If only one neighbour exists, place the bbox just to its side.
      - Ensures a minimum width of 10 px so the caret is always visible.

    Returns:
        ``(x1, y1, x2, y2)`` — may still be ``(0, 0, 0, 0)`` when no
        neighbour information is available at all.
    """
    if not ocr_words_data:
        return (0.0, 0.0, 0.0, 0.0)

    # Locate target_op inside diff_ops
    op_idx: int | None = None
    for i, o in enumerate(diff_ops):
        if o is target_op:
            op_idx = i
            break
    if op_idx is None:
        return (0.0, 0.0, 0.0, 0.0)

    # Find previous and next OCR-backed neighbours
    prev_bbox: tuple[float, float, float, float] | None = None
    next_bbox: tuple[float, float, float, float] | None = None

    for i in range(op_idx - 1, -1, -1):
        idx = diff_ops[i].ocr_index
        if idx is not None and idx < len(ocr_words_data):
            b = ocr_words_data[idx]["bbox"]
            prev_bbox = (b[0], b[1], b[2], b[3])
            break

    for i in range(op_idx + 1, len(diff_ops)):
        idx = diff_ops[i].ocr_index
        if idx is not None and idx < len(ocr_words_data):
            b = ocr_words_data[idx]["bbox"]
            next_bbox = (b[0], b[1], b[2], b[3])
            break

    min_width = 10.0

    if prev_bbox and next_bbox:
        x1 = prev_bbox[2]  # right edge of prev
        x2 = next_bbox[0]  # left edge of next
        if x2 - x1 < min_width:
            mid = (x1 + x2) / 2
            x1 = mid - min_width / 2
            x2 = mid + min_width / 2
        y1 = min(prev_bbox[1], next_bbox[1])
        y2 = max(prev_bbox[3], next_bbox[3])
        return (x1, y1, x2, y2)

    if prev_bbox:
        h = prev_bbox[3] - prev_bbox[1]
        x1 = prev_bbox[2] + 2
        x2 = x1 + max(h * 0.6, min_width)
        return (x1, prev_bbox[1], x2, prev_bbox[3])

    if next_bbox:
        h = next_bbox[3] - next_bbox[1]
        x2 = next_bbox[0] - 2
        x1 = x2 - max(h * 0.6, min_width)
        return (x1, next_bbox[1], x2, next_bbox[3])

    return (0.0, 0.0, 0.0, 0.0)


# ------------------------------------------------------------------
# ------------------------------------------------------------------
# Module-level helper: apply user corrections to DiffOps
# ------------------------------------------------------------------

def _build_hidden_word_indices(
    user_corrections: dict[int | None, "WordAnnotation"],
) -> set[int]:
    """Return the set of word_indices that are merge hidden members.

    A merge leader has ``ocr_word`` containing a space (e.g. "great foods").
    Hidden members are the consecutive word_indices after the leader within
    the same merge group.
    """
    hidden: set[int] = set()
    for word_idx, uc in user_corrections.items():
        if word_idx is None or not uc.ocr_word or " " not in uc.ocr_word:
            continue
        word_count = len(uc.ocr_word.split(" "))
        for off in range(1, word_count):
            hidden.add(word_idx + off)
    return hidden


def _apply_user_corrections(
    diff_ops: list[DiffOp],
    user_corrections: dict[int | None, "WordAnnotation"],
) -> list[DiffOp]:
    """Override diff ops with user-corrected reference_word and error_type.

    For each diff op whose ``ocr_index`` matches a user-corrected annotation,
    replace the ``reference_word`` and ``diff_type`` with the user's values.
    This ensures user corrections survive rediff cycles.

    Merge hidden members (word_indices covered by a merge leader's OCR span)
    are intentionally skipped: their original difflib reference_word is
    preserved in the output so that:
    - ``diff_result_json`` retains the correct ref word for the frontend
      re-pairing pass (computeDisplayDiffOps).
    - ``_apply_merge_repairing`` can later suppress them and re-pair
      orphaned ref words with subsequent EXTRA ops for the annotated image.
    """
    hidden_word_indices = _build_hidden_word_indices(user_corrections)

    result: list[DiffOp] = []
    for op in diff_ops:
        uc = user_corrections.get(op.ocr_index)
        if uc is not None:
            if op.ocr_index in hidden_word_indices:
                # Hidden merge member: preserve original diff op so its
                # reference_word survives in diff_result_json.
                logger.debug(
                    "Hidden merge member skipped: ocr_index=%s, ocr=%r, ref=%r",
                    op.ocr_index, op.ocr_word, op.reference_word,
                )
                result.append(op)
                continue
            # Map ErrorType enum back to DiffType
            corrected_diff_type = DiffType(uc.error_type.value)
            merged_ocr = uc.ocr_word if uc.ocr_word else op.ocr_word
            logger.debug(
                "User correction applied: ocr_index=%s, orig_ocr=%r → merged_ocr=%r, "
                "ref=%r, type=%s, uc_bbox=(%.0f,%.0f,%.0f,%.0f)",
                op.ocr_index, op.ocr_word, merged_ocr,
                uc.reference_word, corrected_diff_type.value,
                uc.bbox_x1, uc.bbox_y1, uc.bbox_x2, uc.bbox_y2,
            )
            result.append(DiffOp(
                diff_type=corrected_diff_type,
                ocr_index=op.ocr_index,
                ref_index=op.ref_index,
                ocr_word=merged_ocr,  # use merged ocr_word if available
                reference_word=uc.reference_word,
            ))
        else:
            result.append(op)
    return result


def _apply_merge_repairing(
    diff_ops: list[DiffOp],
    user_corrections: dict[int | None, "WordAnnotation"],
) -> list[DiffOp]:
    """Suppress merge hidden members and re-pair orphaned ref words with EXTRA ops.

    After ``_apply_user_corrections``, merge hidden members retain their
    original diff ops (with the original difflib reference_word).  This
    function mirrors the frontend ``computeDisplayDiffOps`` re-pairing pass
    so that the annotated image matches what the diff display shows:

    1. Identifies hidden members from merge leader annotations.
    2. For each hidden member with an orphaned reference word (ref ≠ ocr_word):
       - Scans forward for the next available EXTRA op (stopping at alignment
         anchors: CORRECT or MISSING).
       - Re-pairs: EXTRA → WRONG with the orphaned ref word.
    3. Suppresses all hidden members (sets to CORRECT so the annotator skips them).
    """
    hidden_word_indices = _build_hidden_word_indices(user_corrections)

    # Map hidden word_index → its leader's reference_word (the merge target)
    hidden_to_leader_ref: dict[int, str] = {}
    for word_idx, uc in user_corrections.items():
        if word_idx is None or not uc.ocr_word or " " not in uc.ocr_word:
            continue
        word_count = len(uc.ocr_word.split(" "))
        leader_ref = uc.reference_word or ""
        for off in range(1, word_count):
            hidden_to_leader_ref[word_idx + off] = leader_ref

    if not hidden_word_indices:
        return diff_ops

    result: list[DiffOp] = list(diff_ops)
    used_extra_positions: set[int] = set()

    for i, op in enumerate(result):
        if op.ocr_index is None or op.ocr_index not in hidden_word_indices:
            continue

        # Always suppress hidden members (CORRECT → annotator skips them)
        suppressed = DiffOp(
            diff_type=DiffType.CORRECT,
            ocr_index=op.ocr_index,
            ref_index=op.ref_index,
            ocr_word=op.ocr_word,
            reference_word=op.reference_word,
        )

        if not op.reference_word or op.reference_word == op.ocr_word:
            # No orphaned ref — suppress silently
            result[i] = suppressed
            continue

        # Cross-line guard: if hidden member's reference_word equals the
        # leader's reference_word (the merge target, e.g. "grapefruit"),
        # the leader already accounts for it — suppress without consuming EXTRA.
        leader_ref = hidden_to_leader_ref.get(op.ocr_index, "")
        if leader_ref and op.reference_word == leader_ref:
            result[i] = suppressed
            continue

        # Orphaned ref: pair with the next available EXTRA op
        for j in range(i + 1, len(result)):
            if j in used_extra_positions:
                continue
            jop = result[j]
            if jop.ocr_index in hidden_word_indices:
                continue  # skip other hidden members
            if jop.diff_type == DiffType.EXTRA:
                result[j] = DiffOp(
                    diff_type=DiffType.WRONG,
                    ocr_index=jop.ocr_index,
                    ref_index=jop.ref_index,
                    ocr_word=jop.ocr_word,
                    reference_word=op.reference_word,
                )
                used_extra_positions.add(j)
                break
            # Stop at alignment anchors
            if jop.diff_type in (DiffType.CORRECT, DiffType.MISSING):
                break

        result[i] = suppressed

    return result


# ------------------------------------------------------------------
# Module-level helper: split global DiffOps into per-image local ops
# ------------------------------------------------------------------

def _split_diff_ops_for_image(
    all_ops: list[DiffOp],
    start: int,
    end: int,
) -> list[DiffOp]:
    """Extract and re-index DiffOps belonging to one image's OCR word range.

    Args:
        all_ops: Full list of DiffOps from the concatenated diff.
        start: Start offset (inclusive) of this image's words in the concatenated list.
        end: End offset (exclusive) of this image's words in the concatenated list.

    Returns:
        DiffOps with ocr_index mapped to local (0-based) indices.

    Rules:
      - CORRECT / WRONG / EXTRA: have ocr_index — include if start <= ocr_index < end,
        remap to (ocr_index - start).
      - MISSING: no ocr_index — assign to the image that contains the nearest
        preceding op with an ocr_index. If no predecessor, assign to the first
        image (start == 0). This treats missing words as "tail omission" of the
        preceding image.
    """
    result: list[DiffOp] = []

    for i, op in enumerate(all_ops):
        if op.ocr_index is not None:
            # CORRECT, WRONG, or EXTRA — has a concrete OCR position
            if start <= op.ocr_index < end:
                result.append(DiffOp(
                    diff_type=op.diff_type,
                    ocr_index=op.ocr_index - start,
                    ref_index=op.ref_index,
                    ocr_word=op.ocr_word,
                    reference_word=op.reference_word,
                ))
        else:
            # MISSING — find nearest preceding op with an ocr_index
            owner_start = _find_owner_start_for_missing(all_ops, i, start, end)
            if owner_start is not None:
                result.append(DiffOp(
                    diff_type=op.diff_type,
                    ocr_index=None,
                    ref_index=op.ref_index,
                    ocr_word=op.ocr_word,
                    reference_word=op.reference_word,
                ))

    return result


def _find_owner_start_for_missing(
    all_ops: list[DiffOp],
    missing_idx: int,
    start: int,
    end: int,
) -> int | None:
    """Determine if a MISSING op at `missing_idx` belongs to the image [start, end).

    Strategy: look backward for the nearest op with an ocr_index.
    - If found and its ocr_index is in [start, end), this image owns the MISSING op.
    - If no predecessor has ocr_index (i.e., MISSING ops at the very beginning),
      assign to the first image (start == 0).
    - If predecessor's ocr_index is in a *later* image, the MISSING doesn't belong here.

    Additionally, look forward: if the MISSING has no predecessor (leading MISSINGs)
    and the next op with an ocr_index belongs to this image, claim it.
    """
    # Look backward
    for j in range(missing_idx - 1, -1, -1):
        if all_ops[j].ocr_index is not None:
            if start <= all_ops[j].ocr_index < end:
                return start
            return None

    # No predecessor with ocr_index — these are leading MISSINGs.
    # Assign to the first image (start == 0), or if the next op with
    # an ocr_index belongs to this image.
    if start == 0:
        return start

    # Look forward for context
    for j in range(missing_idx + 1, len(all_ops)):
        if all_ops[j].ocr_index is not None:
            if start <= all_ops[j].ocr_index < end:
                return start
            return None

    # All ops are MISSING with no ocr_index at all — assign to first image
    if start == 0:
        return start
    return None
