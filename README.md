# HandwriteDiff

Handwritten text difference identification and annotation tool. Upload reference text and handwritten images, automatically OCR-recognize handwritten content, perform word-level comparison, and visually mark inconsistencies on the original image.

## Architecture

```
handwrite-diff/
├── backend/          FastAPI + SQLAlchemy + Surya OCR
│   ├── app/
│   │   ├── main.py           # FastAPI entry, lifespan, CORS
│   │   ├── config.py         # pydantic-settings
│   │   ├── database.py       # SQLite + async SQLAlchemy
│   │   ├── models/           # ORM models
│   │   ├── schemas/          # Pydantic v2 request/response
│   │   ├── routers/          # API routes
│   │   └── services/         # Core business logic
│   │       ├── ocr_service.py    # Surya word-level OCR
│   │       ├── diff_engine.py    # Word-level diff
│   │       ├── annotator.py      # OpenCV image annotation
│   │       └── pipeline.py       # Processing orchestration
│   ├── storage/              # Runtime file storage
│   └── tests/
├── frontend/         Next.js + Tailwind CSS
│   ├── app/
│   │   ├── page.tsx              # Task list
│   │   ├── new/page.tsx          # Create task
│   │   └── tasks/[taskId]/
│   │       ├── page.tsx          # Task detail
│   │       └── images/[imageId]/
│   │           └── page.tsx      # Diff review (core)
│   ├── components/
│   │   ├── AnnotationEditor.tsx  # Interactive annotation
│   │   ├── AnnotationToolbar.tsx
│   │   ├── ImageViewer.tsx       # Zoom/pan viewer
│   │   ├── DiffDisplay.tsx
│   │   ├── FileUploader.tsx
│   │   └── OcrTextEditor.tsx
│   └── lib/api.ts
└── README.md
```

## Quick Start

### Backend

```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8001
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:3000 in your browser.

## Workflow

1. **Create Task** — Enter a title and paste the reference text
2. **Upload Images** — Drag & drop one or more handwritten images
3. **Process** — Trigger OCR + diff + annotation pipeline
4. **Review** — Interactive annotation editor with:
   - Zoom/pan image viewer
   - SVG overlay annotations (ellipse, underline, caret)
   - Select, move, resize, add, delete annotations
   - Undo/redo (Ctrl+Z / Ctrl+Shift+Z)
   - Edit OCR text and regenerate annotations
   - Export annotated images

## Annotation Types

| Type | Visual | Meaning |
|------|--------|---------|
| WRONG | Red ellipse + correct word above | OCR word differs from reference |
| EXTRA | Orange strikethrough | Word in image but not in reference |
| MISSING | Blue caret (^) + missing word | Word in reference but not in image |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/v1/tasks | Create comparison task |
| GET | /api/v1/tasks | List tasks (paginated) |
| GET | /api/v1/tasks/{id} | Task details |
| DELETE | /api/v1/tasks/{id} | Delete task |
| POST | /api/v1/tasks/{id}/images | Upload images |
| GET | /api/v1/tasks/{id}/images | List task images |
| GET | /api/v1/images/{id} | Image detail + annotations |
| GET | /api/v1/images/{id}/original | Serve original image |
| GET | /api/v1/images/{id}/annotated | Serve annotated image |
| PATCH | /api/v1/images/{id}/ocr | Correct OCR text |
| PUT | /api/v1/images/{id}/annotations | Replace all annotations |
| POST | /api/v1/images/{id}/annotations | Add single annotation |
| DELETE | /api/v1/images/{id}/annotations/{aid} | Delete annotation |
| POST | /api/v1/tasks/{id}/process | Trigger OCR processing |
| GET | /api/v1/tasks/{id}/progress | Processing progress |
| POST | /api/v1/images/{id}/regenerate | Re-run diff + annotate |
| POST | /api/v1/images/{id}/export | Export annotated image |

## Tech Stack

- **Backend**: FastAPI, SQLAlchemy (async), SQLite, Surya OCR, OpenCV
- **Frontend**: Next.js 15, React 19, Tailwind CSS 4
- **OCR**: Surya (GPU-accelerated, word-level bounding boxes)

## Tests

```bash
cd backend
python -m pytest tests/ -v
```
