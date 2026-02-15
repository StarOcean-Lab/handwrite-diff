# HandwriteDiff

> English | [中文](./README.md)

A handwriting comparison tool that identifies differences between handwritten text and reference text. Upload reference text and handwritten images, automatically perform OCR recognition, word-level comparison, and visually annotate inconsistencies on the original image.

## Features

- **OCR Recognition** — Multiple Gemini models (Flash / Pro) via OpenAI-compatible API
- **Word-Level Diff** — LCS-based comparison with English contraction expansion (can't ↔ cannot)
- **Visual Annotations** — Three types: red ellipse (wrong), orange strikethrough (extra), blue caret (missing)
- **Interactive Editor** — SVG overlay with select, move, resize, create, delete annotations, Undo/Redo
- **Live Preview** — Client-side real-time diff recomputation while editing OCR text
- **Drag & Drop Sorting** — Reorder images with automatic diff recalculation
- **Export** — Customizable annotation scale and font size for exported images
- **Bilingual UI** — Chinese / English toggle

## Architecture

```
handwrite-diff/
├── backend/          FastAPI + SQLAlchemy + Gemini OCR
│   ├── app/
│   │   ├── main.py           # FastAPI entry, lifespan, CORS
│   │   ├── config.py         # pydantic-settings (.env)
│   │   ├── database.py       # SQLite + async SQLAlchemy
│   │   ├── models/           # ORM: ComparisonTask, ImageRecord, WordAnnotation
│   │   ├── schemas/          # Pydantic v2 request/response DTOs
│   │   ├── routers/          # /api/v1/ routes
│   │   └── services/
│   │       ├── ocr_service.py    # Gemini Vision OCR (word-level)
│   │       ├── diff_engine.py    # SequenceMatcher word diff
│   │       ├── annotator.py      # OpenCV annotation rendering
│   │       └── pipeline.py       # Processing orchestration
│   ├── storage/              # Runtime: uploads/ + annotated/
│   └── tests/
├── frontend/         Next.js 15 + React 19 + Tailwind v4
│   ├── app/                  # App Router pages
│   ├── components/           # UI components
│   ├── i18n/                 # next-intl config
│   ├── messages/             # zh.json + en.json
│   ├── hooks/                # usePolling custom hook
│   └── lib/                  # API client, diff engine, overlap resolver
└── README.md
```

## Quick Start

### Prerequisites

- Python 3.12+
- Node.js 18+
- Gemini API Key (via OpenAI-compatible endpoint)

### Backend

```bash
cd backend

# Create virtual environment
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Configure environment
cp .env.example .env
# Edit .env with your Gemini API Key and endpoint

# Start dev server
uvicorn app.main:app --reload --host 0.0.0.0 --port 8001
```

### Frontend

```bash
cd frontend

# Install dependencies
npm install

# Start dev server (Turbopack)
npm run dev
```

Open http://localhost:3000 in your browser. The frontend proxies `/api/*` to the backend on `:8001` via Next.js rewrites.

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GEMINI_API_KEY` | ✅ | — | Gemini API key |
| `GEMINI_BASE_URL` | ✅ | — | OpenAI-compatible endpoint (e.g. `https://yunwu.ai`) |
| `GEMINI_MODEL` | — | `gemini-2.5-flash` | Model for OCR |
| `GEMINI_TIMEOUT` | — | `120` | API request timeout (seconds) |
| `DATABASE_URL` | — | `sqlite+aiosqlite:///./handwrite_diff.db` | Database connection string |

## Docker Deployment

### Quick Start

```bash
# 1. Copy and edit environment variables
cp .env.example .env
# Edit .env with your GEMINI_API_KEY and GEMINI_BASE_URL

# 2. Build and start
docker compose up -d

# 3. View logs
docker compose logs -f
```

Once running, open http://localhost:3002 (backend API on `:8001`).

### Architecture

```
┌─────────────┐     ┌──────────────┐
│  frontend   │────▶│   backend    │
│  :3002→3000 │ API │   :8001      │
│  Next.js    │     │   FastAPI    │
└─────────────┘     └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │   SQLite DB  │
                    │  + storage/  │
                    │  (Volume)    │
                    └──────────────┘
```

- **frontend** — Next.js standalone mode, `API_URL=http://backend:8001` injected at build time, communicates with backend via Docker internal network
- **backend** — Multi-stage Python 3.13 image, runs as non-root user with health checks
- **Persistence** — `backend-storage` Docker Volume stores uploaded images, annotated images, and SQLite database

### Docker Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_API_KEY` | — | Gemini API key (required) |
| `GEMINI_BASE_URL` | — | OpenAI-compatible endpoint (required) |
| `GEMINI_MODEL` | `gemini-2.5-flash` | OCR model |
| `CORS_ORIGINS` | `http://localhost:3000` | Allowed CORS origins, comma-separated |
| `DATABASE_URL` | `sqlite+aiosqlite:///./handwrite_diff.db` | Database connection |

### Common Commands

```bash
# Rebuild after code changes
docker compose up -d --build

# Stop services
docker compose down

# Stop and remove data volumes (⚠️ deletes all uploads and database)
docker compose down -v

# Check service status
docker compose ps

# Shell into backend container
docker compose exec backend bash
```

## Workflow

1. **Create Task** — Enter a title, paste reference text, select OCR model
2. **Upload Images** — Drag & drop one or more handwritten images
3. **Process** — Trigger OCR → Diff → Annotation pipeline (real-time progress polling)
4. **Review** — Interactive annotation editor:
   - Zoom/pan image viewer
   - SVG overlay annotations (ellipse, underline, caret)
   - Select, move, resize, create, delete annotations
   - Undo/Redo (Ctrl+Z / Ctrl+Shift+Z)
   - Edit OCR text with live diff preview
   - Regenerate annotations
   - Export annotated images (adjustable scale and font)

## Annotation Types

| Type | Visual | Meaning |
|------|--------|---------|
| **WRONG** | 🔴 Red ellipse + correct word label | OCR word differs from reference |
| **EXTRA** | 🟠 Orange strikethrough | Word in image but not in reference |
| **MISSING** | 🔵 Blue caret (^) + missing word label | Word in reference but not in image |

## Processing Pipeline

```
Upload Image
    ↓
OCR Recognition (Gemini Vision API)
    ↓ word-level bounding boxes
Word Diff (LCS + contraction handling)
    ↓ DiffOp list: CORRECT / WRONG / EXTRA / MISSING
Annotation Rendering (OpenCV)
    ↓ annotated JPG
Persist to DB (WordAnnotation records)
```

Each step updates `ImageRecord.status`, enabling real-time progress polling from the frontend.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/tasks` | Create comparison task |
| `GET` | `/api/v1/tasks` | List tasks (paginated) |
| `GET` | `/api/v1/tasks/{id}` | Task details |
| `DELETE` | `/api/v1/tasks/{id}` | Delete task |
| `POST` | `/api/v1/tasks/{id}/images` | Upload images |
| `GET` | `/api/v1/tasks/{id}/images` | List task images |
| `PUT` | `/api/v1/tasks/{id}/images/reorder` | Reorder images |
| `GET` | `/api/v1/images/{id}` | Image detail + annotations |
| `GET` | `/api/v1/images/{id}/original` | Serve original image |
| `GET` | `/api/v1/images/{id}/annotated` | Serve annotated image |
| `PATCH` | `/api/v1/images/{id}/ocr` | Correct OCR text |
| `PUT` | `/api/v1/images/{id}/annotations` | Replace all annotations |
| `POST` | `/api/v1/images/{id}/annotations` | Add single annotation |
| `DELETE` | `/api/v1/images/{id}/annotations/{aid}` | Delete annotation |
| `POST` | `/api/v1/tasks/{id}/process` | Trigger OCR processing |
| `GET` | `/api/v1/tasks/{id}/progress` | Processing progress |
| `POST` | `/api/v1/images/{id}/regenerate` | Re-run diff + annotate |
| `POST` | `/api/v1/images/{id}/export` | Export annotated image |

## Tech Stack

### Backend

| Technology | Purpose |
|------------|---------|
| [FastAPI](https://fastapi.tiangolo.com/) | Async web framework |
| [SQLAlchemy](https://www.sqlalchemy.org/) 2.0 (async) | ORM + database |
| [aiosqlite](https://github.com/omnilib/aiosqlite) | Async SQLite driver |
| [OpenAI SDK](https://github.com/openai/openai-python) | Gemini API (compatible endpoint) |
| [OpenCV](https://opencv.org/) | Image annotation rendering |
| [Pillow](https://pillow.readthedocs.io/) | Image processing |
| [pydantic-settings](https://docs.pydantic.dev/latest/concepts/pydantic_settings/) | Configuration management |

### Frontend

| Technology | Purpose |
|------------|---------|
| [Next.js](https://nextjs.org/) 15 (App Router, Turbopack) | React framework |
| [React](https://react.dev/) 19 | UI library |
| [Tailwind CSS](https://tailwindcss.com/) v4 | Styling |
| [next-intl](https://next-intl-docs.vercel.app/) | i18n (Chinese/English) |
| [@dnd-kit](https://dndkit.com/) | Drag-and-drop sorting |
| [react-dropzone](https://react-dropzone.js.org/) | File upload |

## Testing

```bash
cd backend

# Run all tests
python -m pytest tests/ -v

# Run a single test file
pytest tests/test_diff_engine.py

# Run a specific test
pytest tests/test_diff_engine.py::TestComputeWordDiff::test_single_replacement -v
```

Tests do not require GPU or Gemini API — `test_diff_engine.py` and `test_annotator.py` test pure logic with synthetic data.

## i18n

The UI supports Chinese and English bilingual switching, powered by [next-intl](https://next-intl-docs.vercel.app/):

- Default language: Chinese (zh)
- Toggle: Language button in the header
- Persistence: Cookie-based, survives page refresh
- No URL prefix: Routes remain unchanged

Translation files are located at `frontend/messages/zh.json` and `frontend/messages/en.json`.

## License

MIT
