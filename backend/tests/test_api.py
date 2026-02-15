"""Integration tests for the API endpoints."""

import io
import tempfile
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from PIL import Image

from app.database import Base, engine
from app.main import app


@pytest_asyncio.fixture(autouse=True)
async def setup_db():
    """Create tables before each test, drop after."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)


@pytest_asyncio.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


def _make_test_image() -> bytes:
    """Create a small PNG image in memory."""
    img = Image.new("RGB", (100, 50), color="white")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


@pytest.mark.asyncio
async def test_health(client: AsyncClient) -> None:
    resp = await client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "healthy"


@pytest.mark.asyncio
async def test_create_and_get_task(client: AsyncClient) -> None:
    resp = await client.post("/api/v1/tasks", json={
        "title": "Test Task",
        "reference_text": "The cat sat on the mat",
    })
    assert resp.status_code == 201
    data = resp.json()
    assert data["title"] == "Test Task"
    assert data["status"] == "created"
    task_id = data["id"]

    resp = await client.get(f"/api/v1/tasks/{task_id}")
    assert resp.status_code == 200
    assert resp.json()["reference_words"] == ["The", "cat", "sat", "on", "the", "mat"]


@pytest.mark.asyncio
async def test_list_tasks(client: AsyncClient) -> None:
    await client.post("/api/v1/tasks", json={"title": "A", "reference_text": "word"})
    await client.post("/api/v1/tasks", json={"title": "B", "reference_text": "word"})

    resp = await client.get("/api/v1/tasks?page=1&limit=10")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 2
    assert len(data["items"]) == 2


@pytest.mark.asyncio
async def test_delete_task(client: AsyncClient) -> None:
    resp = await client.post("/api/v1/tasks", json={"title": "X", "reference_text": "y"})
    task_id = resp.json()["id"]

    resp = await client.delete(f"/api/v1/tasks/{task_id}")
    assert resp.status_code == 204

    resp = await client.get(f"/api/v1/tasks/{task_id}")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_upload_images(client: AsyncClient) -> None:
    resp = await client.post("/api/v1/tasks", json={
        "title": "Upload Test",
        "reference_text": "hello world",
    })
    task_id = resp.json()["id"]

    img_bytes = _make_test_image()
    resp = await client.post(
        f"/api/v1/tasks/{task_id}/images",
        files=[
            ("files", ("test1.png", img_bytes, "image/png")),
            ("files", ("test2.png", img_bytes, "image/png")),
        ],
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["uploaded"] == 2
    assert len(data["images"]) == 2


@pytest.mark.asyncio
async def test_list_task_images(client: AsyncClient) -> None:
    resp = await client.post("/api/v1/tasks", json={
        "title": "List Images",
        "reference_text": "test",
    })
    task_id = resp.json()["id"]

    img_bytes = _make_test_image()
    await client.post(
        f"/api/v1/tasks/{task_id}/images",
        files=[("files", ("img.png", img_bytes, "image/png"))],
    )

    resp = await client.get(f"/api/v1/tasks/{task_id}/images")
    assert resp.status_code == 200
    assert len(resp.json()) == 1


@pytest.mark.asyncio
async def test_task_not_found(client: AsyncClient) -> None:
    resp = await client.get("/api/v1/tasks/9999")
    assert resp.status_code == 404
