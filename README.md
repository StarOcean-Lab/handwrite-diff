# HandwriteDiff

手写文本差异识别与标注工具。上传参考文本和手写图片，自动 OCR 识别手写内容，进行逐词对比，在原图上可视化标注差异。

Handwritten text difference identification and annotation tool. Upload reference text and handwritten images, automatically OCR-recognize handwritten content, perform word-level comparison, and visually mark inconsistencies on the original image.

## Features

- **OCR 识别** — 支持多种 Gemini 模型（Flash / Pro），通过 OpenAI 兼容接口调用
- **逐词对比** — 基于 LCS 算法的 word-level diff，支持英文缩写展开（can't ↔ cannot）
- **可视化标注** — 三种标注类型：红色椭圆（错误）、橙色删除线（多余）、蓝色插入符（遗漏）
- **交互式编辑器** — SVG 叠加层支持选择、移动、缩放、新增、删除标注，Undo/Redo
- **实时预览** — 编辑 OCR 文本时客户端即时重新 diff
- **拖拽排序** — 图片支持拖拽排序，自动重新计算 diff
- **导出** — 自定义标注缩放和字体大小，导出标注图片
- **双语界面** — 中文 / English 一键切换

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
│   │       ├── ocr_service.py    # Gemini vision OCR (word-level)
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
│   ├── hooks/                # usePolling
│   └── lib/                  # api client, diff engine, overlap resolver
└── README.md
```

## Quick Start

### Prerequisites

- Python 3.12+
- Node.js 18+
- Gemini API Key（通过 OpenAI 兼容接口）

### Backend

```bash
cd backend

# 创建虚拟环境
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate

# 安装依赖
pip install -r requirements.txt

# 配置环境变量
cp .env.example .env
# 编辑 .env 填入你的 Gemini API Key 和 endpoint

# 启动开发服务器
uvicorn app.main:app --reload --host 0.0.0.0 --port 8001
```

### Frontend

```bash
cd frontend

# 安装依赖
npm install

# 启动开发服务器 (Turbopack)
npm run dev
```

打开 http://localhost:3000 即可使用。Frontend 通过 Next.js rewrites 自动代理 `/api/*` 到 backend `:8001`。

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GEMINI_API_KEY` | ✅ | — | Gemini API 密钥 |
| `GEMINI_BASE_URL` | ✅ | — | OpenAI 兼容接口地址（如 `https://yunwu.ai`） |
| `GEMINI_MODEL` | — | `gemini-2.5-flash` | OCR 使用的模型 |
| `GEMINI_TIMEOUT` | — | `120` | API 请求超时（秒） |
| `DATABASE_URL` | — | `sqlite+aiosqlite:///./handwrite_diff.db` | 数据库连接字符串 |

## Workflow

1. **创建任务** — 输入标题，粘贴参考文本，选择 OCR 模型
2. **上传图片** — 拖拽上传一张或多张手写图片
3. **处理** — 触发 OCR → Diff → Annotation 流水线（实时进度轮询）
4. **审阅** — 交互式标注编辑器：
   - 缩放/平移图片查看器
   - SVG 叠加标注（椭圆、下划线、插入符）
   - 选择、移动、缩放、新增、删除标注
   - Undo/Redo（Ctrl+Z / Ctrl+Shift+Z）
   - 编辑 OCR 文本并实时预览 diff
   - 重新生成标注
   - 导出标注图片（可调整缩放和字体）

## Annotation Types

| Type | Visual | Meaning |
|------|--------|---------|
| **WRONG** | 🔴 Red ellipse + correct word label | OCR 词与参考文本不一致 |
| **EXTRA** | 🟠 Orange strikethrough | 图片中有但参考文本中没有 |
| **MISSING** | 🔵 Blue caret (^) + missing word label | 参考文本中有但图片中没有 |

## Processing Pipeline

```
Upload Image
    ↓
OCR (Gemini Vision API)
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
| `POST` | `/api/v1/tasks` | 创建对比任务 |
| `GET` | `/api/v1/tasks` | 任务列表（分页） |
| `GET` | `/api/v1/tasks/{id}` | 任务详情 |
| `DELETE` | `/api/v1/tasks/{id}` | 删除任务 |
| `POST` | `/api/v1/tasks/{id}/images` | 上传图片 |
| `GET` | `/api/v1/tasks/{id}/images` | 任务图片列表 |
| `PUT` | `/api/v1/tasks/{id}/images/reorder` | 图片排序 |
| `GET` | `/api/v1/images/{id}` | 图片详情 + 标注 |
| `GET` | `/api/v1/images/{id}/original` | 原始图片 |
| `GET` | `/api/v1/images/{id}/annotated` | 标注图片 |
| `PATCH` | `/api/v1/images/{id}/ocr` | 修正 OCR 文本 |
| `PUT` | `/api/v1/images/{id}/annotations` | 替换全部标注 |
| `POST` | `/api/v1/images/{id}/annotations` | 添加单条标注 |
| `DELETE` | `/api/v1/images/{id}/annotations/{aid}` | 删除标注 |
| `POST` | `/api/v1/tasks/{id}/process` | 触发 OCR 处理 |
| `GET` | `/api/v1/tasks/{id}/progress` | 处理进度 |
| `POST` | `/api/v1/images/{id}/regenerate` | 重新 diff + 标注 |
| `POST` | `/api/v1/images/{id}/export` | 导出标注图片 |

## Tech Stack

### Backend

| Technology | Purpose |
|------------|---------|
| [FastAPI](https://fastapi.tiangolo.com/) | Async web framework |
| [SQLAlchemy](https://www.sqlalchemy.org/) 2.0 (async) | ORM + database |
| [aiosqlite](https://github.com/omnilib/aiosqlite) | Async SQLite driver |
| [OpenAI SDK](https://github.com/openai/openai-python) | Gemini API (兼容接口) |
| [OpenCV](https://opencv.org/) | Image annotation rendering |
| [Pillow](https://pillow.readthedocs.io/) | Image processing |
| [pydantic-settings](https://docs.pydantic.dev/latest/concepts/pydantic_settings/) | Configuration management |

### Frontend

| Technology | Purpose |
|------------|---------|
| [Next.js](https://nextjs.org/) 15 (App Router, Turbopack) | React framework |
| [React](https://react.dev/) 19 | UI library |
| [Tailwind CSS](https://tailwindcss.com/) v4 | Styling |
| [next-intl](https://next-intl-docs.vercel.app/) | i18n (中/英双语) |
| [@dnd-kit](https://dndkit.com/) | Drag-and-drop sorting |
| [react-dropzone](https://react-dropzone.js.org/) | File upload |

## Testing

```bash
cd backend

# 运行所有测试
python -m pytest tests/ -v

# 运行单个测试文件
pytest tests/test_diff_engine.py

# 运行指定测试
pytest tests/test_diff_engine.py::TestComputeWordDiff::test_single_replacement -v
```

测试不依赖 GPU 或 Gemini API — `test_diff_engine.py` 和 `test_annotator.py` 使用合成数据测试纯逻辑。

## i18n

界面支持中文和英文双语切换，基于 [next-intl](https://next-intl-docs.vercel.app/) 实现：

- 默认语言：中文（zh）
- 切换方式：Header 右上角语言按钮
- 持久化：Cookie 存储，刷新不丢失
- 无 URL 前缀：不改变路由结构

翻译文件位于 `frontend/messages/zh.json` 和 `frontend/messages/en.json`。

## License

MIT
