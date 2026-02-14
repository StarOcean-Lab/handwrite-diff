# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

HandwriteDiff is a handwriting comparison tool that takes photos of handwritten text, runs OCR to extract words, diffs them against reference text, and produces annotated images highlighting errors. It uses a Python/FastAPI backend with Surya OCR and a Next.js frontend with an interactive SVG annotation editor.

## Architecture

Two-service architecture with a clear API boundary:

- **Backend** (`backend/`): FastAPI (Python 3.13), async SQLAlchemy with SQLite (aiosqlite), Surya OCR for recognition. Background task pipeline: OCR -> word-level diff (difflib.SequenceMatcher) -> OpenCV annotation rendering. All API routes under `/api/v1/`.
- **Frontend** (`frontend/`): Next.js 15 (App Router, Turbopack), React 19, Tailwind CSS v4. Proxies `/api/*` to backend via `next.config.js` rewrites. No state management library -- uses React hooks + polling for async processing status.

### Processing Pipeline

The core flow lives in `backend/app/services/pipeline.py` (`ProcessingPipeline`):

1. **OCR** (`ocr_service.py`): Surya OCR with lazy-loaded singleton predictors, OOM retry with automatic batch-size reduction. Runs GPU work via `asyncio.to_thread`. Returns word-level bboxes by proportionally splitting line bboxes.
2. **Diff** (`diff_engine.py`): Word-level comparison using `difflib.SequenceMatcher` on normalized (lowercased, punctuation-stripped) words. Produces `DiffOp` list with types: CORRECT, WRONG, MISSING, EXTRA.
3. **Annotate** (`annotator.py`): Draws onto original image with OpenCV -- red ellipses for WRONG, orange strikethrough for EXTRA, blue carets for MISSING. Saves static annotated JPG.
4. **Persist**: Each step updates `ImageRecord.status` so frontend can poll progress.

### Data Model (3 tables)

- `ComparisonTask`: title, reference_text, reference_words (JSON), status (created/processing/completed/failed), image counts
- `ImageRecord`: FK to task, image_path, ocr_raw_text, ocr_words_json, diff_result_json, annotated_image_path, status (pending -> ocr_processing -> ocr_done -> diff_done -> annotated -> reviewed -> failed)
- `WordAnnotation`: FK to image, word_index, ocr_word, reference_word, error_type, annotation_shape (ellipse/underline/caret), bbox coordinates, is_auto/is_user_corrected flags

### Frontend Page Flow

- `/` -- Task list with status badges and progress bars
- `/new` -- 3-step wizard: enter reference text -> upload images -> trigger processing
- `/tasks/[taskId]` -- Task detail with image grid, polling progress during processing
- `/tasks/[taskId]/images/[imageId]` -- Image review: side-by-side original + interactive SVG annotation editor, OCR text editor, word-by-word diff display. Annotations support undo/redo (`useReducer` with past/future stacks), drag-to-move, draw new shapes, keyboard shortcuts (Ctrl+Z, Delete).

## Commands

### Backend

```bash
cd backend

# Install dependencies (use a virtualenv)
pip install -r requirements.txt

# Run dev server
uvicorn app.main:app --reload --host 0.0.0.0 --port 8001
# or: python -m app.main

# Run all tests
pytest

# Run a single test file
pytest tests/test_diff_engine.py

# Run a single test by name
pytest tests/test_diff_engine.py::TestComputeWordDiff::test_single_replacement -v
```

### Frontend

```bash
cd frontend

# Install dependencies
npm install

# Run dev server (Turbopack)
npm run dev

# Build for production
npm run build

# Lint
npm run lint
```

### Running both together

Backend on `:8001`, frontend on `:3000`. Frontend proxies `/api/*` to backend automatically via Next.js rewrites.

## Key Conventions

- **Backend config**: `pydantic-settings` in `backend/app/config.py`, reads `.env` file. Default DB is `sqlite+aiosqlite:///./handwrite_diff.db`. Storage dirs are `storage/uploads/` and `storage/annotated/`.
- **Dependency injection**: `DB = Annotated[AsyncSession, Depends(get_db)]` shorthand in `backend/app/deps.py` -- used across all routers.
- **JSON-in-TEXT columns**: `ocr_words_json`, `diff_result_json`, `reference_words` are stored as JSON strings in SQLite TEXT columns, serialized/deserialized manually with `json.dumps`/`json.loads`.
- **Background tasks**: Processing uses FastAPI `BackgroundTasks`, not Celery. Background functions create their own DB session via `async_session_factory()`.
- **Frontend CSS**: Tailwind v4 with CSS custom properties for theming (`globals.css`). No `tailwind.config.js` -- uses `@tailwindcss/postcss` plugin directly.
- **Path alias**: `@/*` maps to project root in frontend TypeScript.
- **API client**: All backend calls go through `frontend/lib/api.ts` -- typed fetch wrappers with no external HTTP library.

## Testing

Backend tests use `pytest` + `pytest-asyncio` + `httpx.AsyncClient` (ASGI transport). The `test_api.py` integration tests create/drop all tables per test via the `setup_db` fixture. Tests do **not** require GPU/Surya -- `test_diff_engine.py` and `test_annotator.py` test pure logic with synthetic data.

No frontend tests exist yet.
