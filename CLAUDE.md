# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

HandwriteDiff is a handwriting comparison tool that takes photos of handwritten text, runs OCR to extract words, diffs them against reference text, and produces annotated images highlighting errors. It uses a Python/FastAPI backend with Gemini OCR (via OpenAI-compatible API) and a Next.js frontend with an interactive SVG annotation editor.

## Architecture

Two-service architecture with a clear API boundary:

- **Backend** (`backend/`): FastAPI (Python 3.13), async SQLAlchemy with SQLite (aiosqlite), Gemini OCR via OpenAI-compatible API. Background task pipeline: preprocessing -> OCR -> bbox refinement -> word-level diff (difflib.SequenceMatcher) -> OpenCV annotation rendering. All API routes under `/api/v1/`.
- **Frontend** (`frontend/`): Next.js 15 (App Router, Turbopack), React 19, Tailwind CSS v4. Proxies `/api/*` to backend via `next.config.js` rewrites. No state management library -- uses React hooks + polling for async processing status.

### Processing Pipeline

The core flow lives in `backend/app/services/pipeline.py` (`ProcessingPipeline`), structured as two phases:

**Phase 1 — Per-image OCR** (`_run_ocr_only`):
1. **Preprocess** (`preprocessing.py`): Auto-deskew (Hough lines) + CLAHE contrast enhancement. Creates a temp file; the original image is never modified.
2. **OCR** (`ocr_service.py`): Calls Gemini via OpenAI-compatible API with a vision prompt. Returns word-level bboxes normalized 0-1000, converted to pixel coords. Exponential backoff retry (`gemini_max_retries`).
3. **Bbox refinement** (`bbox_refiner.py`): Tightens coarse Gemini bboxes using adaptive thresholding on ink pixels. Falls back to original if insufficient ink or area grows too much.

**Phase 2 — Task-level diff + annotate** (`_run_concatenated_diff_and_annotate`):
4. **Concatenate**: All images' OCR words are concatenated in `sort_order` to form one big word list.
5. **Diff** (`diff_engine.py`): Single `difflib.SequenceMatcher` diff on the concatenated list vs. reference. Produces `DiffOp` list with types: CORRECT, WRONG, MISSING, EXTRA. Includes number-word equivalence (e.g., "two" == "2").
6. **Split back**: `_split_diff_ops_for_image` re-maps global diff ops back to per-image local indices.
7. **Annotate** (`annotator.py`): Draws onto original image with OpenCV -- red ellipses for WRONG, orange strikethrough for EXTRA, blue carets for MISSING. MISSING words use bbox inferred from neighbors.
8. **Persist**: Each step updates `ImageRecord.status` so frontend can poll progress.

`rediff_task()` re-runs Phase 2 only (skips OCR), called after image reordering or OCR text correction.

CPU-intensive steps (`preprocess_for_ocr`, `refine_word_bboxes`, `annotate_image`) are wrapped with `asyncio.to_thread()` to avoid blocking the uvicorn event loop. Phase 2 uses a single atomic `commit` per image inside a `try/except/rollback` block; a failed image is marked FAILED without affecting siblings.

### Data Model (4 tables)

- `ModelProvider`: name (unique), base_url, api_key, default_model, models_json (JSON list), is_default flag. Stores OCR provider configs; API key is masked (`xxxx***xxxx`) in all responses. Has one-to-many with `ComparisonTask`.
- `ComparisonTask`: title, reference_text, reference_words (JSON), status (created/processing/completed/failed), image counts, `ocr_model` (optional per-task model override)
- `ImageRecord`: FK to task, image_path, ocr_raw_text, ocr_words_json, diff_result_json, annotated_image_path, status (pending -> ocr_processing -> ocr_done -> diff_done -> annotated -> reviewed -> failed), sort_order
- `WordAnnotation`: FK to image, word_index, ocr_word, reference_word, error_type, annotation_shape (ellipse/underline/caret), bbox coordinates, is_auto/is_user_corrected flags

### Frontend Page Flow

- `/` -- Task list with status badges and progress bars
- `/new` -- 3-step wizard: enter reference text -> upload images -> trigger processing
- `/tasks/[taskId]` -- Task detail with image grid, stats row, polling progress during processing. Shows export-all-zip button when task is completed.
- `/tasks/[taskId]/images/[imageId]` -- Image review: side-by-side original + interactive SVG annotation editor, OCR text editor, word-by-word diff display. Annotations support undo/redo (`useReducer` with past/future stacks), drag-to-move, draw new shapes, keyboard shortcuts (Ctrl+Z, Delete).
- `/providers` -- Provider management: list/create/edit/delete OCR providers, set default, expandable connection test panel (tests individual models against stored or inline credentials, shows latency).

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

### Docker Deployment

```bash
# ⚠️ Must rebuild after every code change — containers run the built image, not live source
docker compose up --build -d

# Rebuild a single service only (faster when only one side changed)
docker compose up --build -d backend
docker compose up --build -d frontend

# View logs
docker compose logs -f

# Stop all services
docker compose down
```

Frontend exposed on `:3002`, backend on `:8001`. The `.env` file at **repo root** (not `backend/`) is loaded by the backend container (`env_file: .env`). Backend storage is persisted in the `backend-storage` named volume.

## Environment Setup

For local development, create `backend/.env`. For Docker, create `.env` at the repo root.

```env
GEMINI_API_KEY=your_api_key_here
GEMINI_BASE_URL=https://your-openai-compatible-proxy/v1
GEMINI_MODEL=gemini-2.5-flash          # optional, this is the default
CORS_ORIGINS=http://localhost:3000      # comma-separated if multiple
```

`GEMINI_BASE_URL` must be an OpenAI-compatible endpoint. The client auto-appends `/v1` if missing. Proxy env vars (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`) are cleared on client init since the proxy service itself is the relay.

## Key Conventions

- **Backend config**: `pydantic-settings` in `backend/app/config.py`, reads `.env` file. Default DB is `sqlite+aiosqlite:///./handwrite_diff.db`. Storage dirs are `storage/uploads/` and `storage/annotated/`.
- **Dependency injection**: `DB = Annotated[AsyncSession, Depends(get_db)]` shorthand in `backend/app/deps.py` -- used across all routers.
- **JSON-in-TEXT columns**: `ocr_words_json`, `diff_result_json`, `reference_words` are stored as JSON strings in SQLite TEXT columns, serialized/deserialized manually with `json.dumps`/`json.loads`.
- **Background tasks**: Processing uses FastAPI `BackgroundTasks`, not Celery. Background functions create their own DB session via `async_session_factory()`.
- **Async CPU work**: Any synchronous, CPU-intensive operation called from an `async` function must be wrapped with `asyncio.to_thread()` to avoid blocking the event loop.
- **Atomic transactions**: In the pipeline's per-image loop, all DB mutations for a single image (diff result, annotations, annotated path) are committed in one `await self._db.commit()` inside `try/except/rollback`.
- **Frontend CSS**: Tailwind v4 with CSS custom properties for theming (`globals.css`). No `tailwind.config.js` -- uses `@tailwindcss/postcss` plugin directly.
- **Path alias**: `@/*` maps to project root in frontend TypeScript.
- **API client**: All backend calls go through `frontend/lib/api.ts` -- typed fetch wrappers with no external HTTP library.
- **Per-task model override**: `ComparisonTask.ocr_model` and `TaskCreate.ocr_model` allow selecting a different Gemini model per task; falls back to `settings.gemini_model`.
- **Provider management**: `ModelProvider` table + `/api/v1/providers` router handles multi-provider OCR config. API keys are always masked in responses. `POST /{id}/test-models` tests stored credentials; `POST /test` tests ephemeral credentials without saving. 15-second timeout on test calls.
- **Batch export**: `GET /api/v1/tasks/{id}/export-zip` streams all annotated images as a ZIP. Files are named `01_<label>.jpg` in sort_order. Frontend triggers download via `exportTaskZip()` in `lib/api.ts`.

## Testing

Backend tests use `pytest` + `pytest-asyncio` + `httpx.AsyncClient` (ASGI transport). The `test_api.py` integration tests create/drop all tables per test via the `setup_db` fixture. Tests do **not** require GPU or API calls -- `test_diff_engine.py` and `test_annotator.py` test pure logic with synthetic data.

No frontend tests exist yet.
