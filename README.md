# HandwriteDiff

> [English](./README.en.md) | 中文

手写文本差异识别与标注工具。上传参考文本和手写图片，自动 OCR 识别手写内容，进行逐词对比，在原图上可视化标注差异。

## 功能特性

- **多提供商 OCR** — 界面管理多个 OpenAI 兼容 OCR 提供商（API Key、模型列表），支持按任务选择提供商和覆盖模型
- **图像预处理** — 自动纠偏（Hough 直线检测）+ CLAHE 对比度增强，提升 OCR 精度
- **词级 bbox 精化** — 自适应阈值收紧粗糙的 OCR 边界框
- **逐词对比** — 基于 LCS 算法的 word-level diff，支持英文缩写展开（can't ↔ cannot）和数字等价（"two" == "2"）
- **可视化标注** — 三种标注类型：红色椭圆（错误）、橙色删除线（多余）、蓝色插入符（遗漏）
- **交互式编辑器** — SVG 叠加层支持选择、移动、缩放、新增、删除标注，Undo/Redo
- **实时预览** — 编辑 OCR 文本时客户端即时重新计算 diff
- **拖拽排序** — 图片支持拖拽排序，自动重新计算 diff
- **批量导出** — 已完成任务一键下载全部标注图 ZIP；单张图片支持自定义标注缩放和字体导出
- **双语界面** — 中文 / English 一键切换

## 项目结构

```
handwrite-diff/
├── backend/          FastAPI + SQLAlchemy + Gemini OCR
│   ├── app/
│   │   ├── main.py           # FastAPI 入口、生命周期、CORS
│   │   ├── config.py         # pydantic-settings 配置（.env）
│   │   ├── database.py       # SQLite + async SQLAlchemy
│   │   ├── models/           # ORM：ModelProvider, ComparisonTask, ImageRecord, WordAnnotation
│   │   ├── schemas/          # Pydantic v2 请求/响应 DTO
│   │   ├── routers/          # /api/v1/ 路由（tasks, images, providers）
│   │   └── services/
│   │       ├── ocr_service.py    # Gemini Vision OCR（词级别）
│   │       ├── preprocessing.py  # 图像预处理（纠偏 + CLAHE）
│   │       ├── bbox_refiner.py   # OCR bbox 自适应精化
│   │       ├── diff_engine.py    # SequenceMatcher 逐词对比
│   │       ├── annotator.py      # OpenCV 图像标注渲染
│   │       └── pipeline.py       # 处理流水线编排
│   ├── storage/              # 运行时存储：uploads/ + annotated/
│   └── tests/
├── frontend/         Next.js 15 + React 19 + Tailwind v4
│   ├── app/                  # App Router 页面（/、/new、/tasks、/providers）
│   ├── components/           # UI 组件
│   ├── i18n/                 # next-intl 国际化配置
│   ├── messages/             # zh.json + en.json 翻译文件
│   ├── hooks/                # usePolling 等自定义 Hook
│   └── lib/                  # API 客户端、diff 引擎、标签重叠解算
└── README.md
```

## 快速开始

### 前置条件

- Python 3.12+
- Node.js 18+
- Gemini API Key（通过 OpenAI 兼容接口）

### 后端

```bash
cd backend

# 创建虚拟环境
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate

# 安装依赖
pip install -r requirements.txt

# 配置环境变量
cp .env.example .env
# 编辑 .env 填入你的 Gemini API Key 和接口地址

# 启动开发服务器
uvicorn app.main:app --reload --host 0.0.0.0 --port 8001
```

### 前端

```bash
cd frontend

# 安装依赖
npm install

# 启动开发服务器（Turbopack）
npm run dev
```

打开 http://localhost:3000 即可使用。前端通过 Next.js rewrites 自动代理 `/api/*` 到后端 `:8001`。

### 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `GEMINI_API_KEY` | ✅ | — | 全局 Gemini API 密钥（提供商管理可覆盖） |
| `GEMINI_BASE_URL` | ✅ | — | OpenAI 兼容接口地址（如 `https://yunwu.ai`） |
| `GEMINI_MODEL` | — | `gemini-2.5-flash` | 全局默认 OCR 模型 |
| `GEMINI_TIMEOUT` | — | `120` | API 请求超时（秒） |
| `DATABASE_URL` | — | `sqlite+aiosqlite:///./handwrite_diff.db` | 数据库连接字符串 |

> 通过「模型提供商」管理页面配置的提供商会覆盖以上全局 `.env` 配置，实现多账号/多端点管理。

## Docker 部署

### 快速启动

```bash
# 1. 复制并编辑环境变量（放置在仓库根目录）
cp .env.example .env
# 编辑 .env，填入 GEMINI_API_KEY 和 GEMINI_BASE_URL

# 2. 构建并启动
docker compose up --build -d

# 3. 查看日志
docker compose logs -f
```

启动后访问 http://localhost:3002 即可使用（后端 API 在 `:8001`）。

### 架构说明

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

- **frontend** — Next.js standalone 模式，构建时注入 `API_URL=http://backend:8001`，通过 Docker 内部网络访问后端
- **backend** — 多阶段构建的 Python 3.13 镜像，非 root 用户运行，带健康检查
- **数据持久化** — `backend-storage` Docker Volume 保存上传图片、标注图片和 SQLite 数据库

### 常用命令

```bash
# 重新构建（代码更新后必须执行）
docker compose up --build -d

# 仅重建某一服务
docker compose up --build -d backend
docker compose up --build -d frontend

# 停止服务
docker compose down

# 停止并清除数据卷（⚠️ 会删除所有上传和数据库）
docker compose down -v

# 查看服务状态
docker compose ps

# 进入后端容器调试
docker compose exec backend bash
```

## 使用流程

1. **配置提供商**（可选）— 前往「模型提供商」页面添加 OCR API 提供商，设置为默认；也可直接使用 `.env` 全局配置
2. **创建任务** — 输入标题，粘贴参考文本，选择提供商和 OCR 模型（可选覆盖）
3. **上传图片** — 拖拽上传一张或多张手写图片
4. **处理** — 触发 OCR → Diff → Annotation 流水线（实时进度轮询）
5. **审阅** — 交互式标注编辑器：
   - 缩放/平移图片查看器
   - SVG 叠加标注（椭圆、下划线、插入符）
   - 选择、移动、缩放、新增、删除标注
   - Undo/Redo（Ctrl+Z / Ctrl+Shift+Z）
   - 编辑 OCR 文本并实时预览 diff
   - 重新生成标注
   - 导出单张标注图片（可调整缩放和字体）
6. **批量导出** — 任务完成后在详情页点击「导出全部标注图」下载 ZIP

## 标注类型

| 类型 | 外观 | 含义 |
|------|------|------|
| **WRONG** | 🔴 红色椭圆 + 正确词标签 | OCR 词与参考文本不一致 |
| **EXTRA** | 🟠 橙色删除线 | 图片中有但参考文本中没有 |
| **MISSING** | 🔵 蓝色插入符 (^) + 遗漏词标签 | 参考文本中有但图片中没有 |

## 处理流水线

```
上传图片
    ↓
预处理（自动纠偏 + CLAHE 对比度增强）
    ↓
OCR 识别（Gemini Vision API）
    ↓ 词级别边界框
Bbox 精化（自适应阈值收紧边界框）
    ↓
逐词对比（LCS + 缩写展开，全图片拼接后单次 diff）
    ↓ DiffOp 列表：CORRECT / WRONG / EXTRA / MISSING
标注渲染（OpenCV）
    ↓ 标注后的 JPG 图片
持久化到数据库（WordAnnotation 记录）
```

每个步骤都会更新 `ImageRecord.status`，前端可实时轮询处理进度。CPU 密集步骤（预处理、精化、渲染）通过 `asyncio.to_thread` 在线程池中执行，不阻塞事件循环。

## API 接口

### 任务与图片

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/v1/tasks` | 创建对比任务 |
| `GET` | `/api/v1/tasks` | 任务列表（分页） |
| `GET` | `/api/v1/tasks/{id}` | 任务详情 |
| `PATCH` | `/api/v1/tasks/{id}` | 更新参考文本并重新 diff |
| `DELETE` | `/api/v1/tasks/{id}` | 删除任务 |
| `POST` | `/api/v1/tasks/{id}/process` | 触发 OCR 处理 |
| `GET` | `/api/v1/tasks/{id}/progress` | 处理进度 |
| `GET` | `/api/v1/tasks/{id}/stats` | 准确率统计 |
| `GET` | `/api/v1/tasks/{id}/export-zip` | 下载全部标注图 ZIP |
| `POST` | `/api/v1/tasks/{id}/images` | 上传图片 |
| `GET` | `/api/v1/tasks/{id}/images` | 任务图片列表 |
| `PUT` | `/api/v1/tasks/{id}/images/reorder` | 图片排序 |
| `GET` | `/api/v1/images/{id}` | 图片详情 + 标注 |
| `GET` | `/api/v1/images/{id}/original` | 原始图片 |
| `GET` | `/api/v1/images/{id}/annotated` | 标注后图片 |
| `PATCH` | `/api/v1/images/{id}/ocr` | 修正 OCR 文本 |
| `PUT` | `/api/v1/images/{id}/annotations` | 替换全部标注 |
| `POST` | `/api/v1/images/{id}/annotations` | 添加单条标注 |
| `DELETE` | `/api/v1/images/{id}/annotations/{aid}` | 删除标注 |
| `POST` | `/api/v1/images/{id}/regenerate` | 重新 diff + 标注 |
| `POST` | `/api/v1/images/{id}/render-export` | 渲染导出图（自定义标注） |

### 模型提供商

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/v1/providers` | 提供商列表 |
| `POST` | `/api/v1/providers` | 创建提供商 |
| `PATCH` | `/api/v1/providers/{id}` | 编辑提供商 |
| `DELETE` | `/api/v1/providers/{id}` | 删除提供商 |
| `POST` | `/api/v1/providers/{id}/set-default` | 设为默认提供商 |
| `POST` | `/api/v1/providers/{id}/test-models` | 测试已存储凭据 |
| `POST` | `/api/v1/providers/test` | 测试临时凭据（不保存） |

## 技术栈

### 后端

| 技术 | 用途 |
|------|------|
| [FastAPI](https://fastapi.tiangolo.com/) | 异步 Web 框架 |
| [SQLAlchemy](https://www.sqlalchemy.org/) 2.0 (async) | ORM + 数据库 |
| [aiosqlite](https://github.com/omnilib/aiosqlite) | 异步 SQLite 驱动 |
| [OpenAI SDK](https://github.com/openai/openai-python) | Gemini API（兼容接口） |
| [OpenCV](https://opencv.org/) | 图像标注渲染 + bbox 精化 |
| [Pillow](https://pillow.readthedocs.io/) | 图像处理 |
| [pydantic-settings](https://docs.pydantic.dev/latest/concepts/pydantic_settings/) | 配置管理 |

### 前端

| 技术 | 用途 |
|------|------|
| [Next.js](https://nextjs.org/) 15 (App Router, Turbopack) | React 框架 |
| [React](https://react.dev/) 19 | UI 库 |
| [Tailwind CSS](https://tailwindcss.com/) v4 | 样式 |
| [next-intl](https://next-intl-docs.vercel.app/) | 国际化（中/英双语） |
| [@dnd-kit](https://dndkit.com/) | 拖拽排序 |
| [react-dropzone](https://react-dropzone.js.org/) | 文件上传 |

## 测试

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

## 国际化

界面支持中文和英文双语切换，基于 [next-intl](https://next-intl-docs.vercel.app/) 实现：

- 默认语言：中文（zh）
- 切换方式：Header 右上角语言按钮
- 持久化：Cookie 存储，刷新后语言偏好保持
- 无 URL 前缀：不改变路由结构

翻译文件位于 `frontend/messages/zh.json` 和 `frontend/messages/en.json`。

## 许可证

MIT
