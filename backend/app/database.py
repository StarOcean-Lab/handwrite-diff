"""SQLite + SQLAlchemy async database setup."""

import logging

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.config import get_settings

logger = logging.getLogger("handwrite_diff.database")


class Base(DeclarativeBase):
    """Declarative base for all ORM models."""
    pass


engine = create_async_engine(
    get_settings().database_url,
    echo=get_settings().debug,
)

async_session_factory = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


async def _migrate_add_columns(conn) -> None:  # type: ignore[no-untyped-def]
    """Idempotent lightweight migration: add new columns to existing tables.

    Uses ``PRAGMA table_info`` to check whether columns already exist
    and ``ALTER TABLE ADD COLUMN`` to add missing ones. Safe to re-run.
    """
    # Columns to add: (table, column_name, column_type, default_expr)
    new_columns = [
        ("word_annotations", "label_x", "REAL", None),
        ("word_annotations", "label_y", "REAL", None),
        ("word_annotations", "label_font_size", "REAL", None),
        ("comparison_tasks", "provider_id", "INTEGER", None),
        ("model_providers", "models_json", "TEXT", None),
    ]

    for table, col_name, col_type, default in new_columns:
        result = await conn.execute(text(f"PRAGMA table_info({table})"))
        existing = {row[1] for row in result.fetchall()}
        if col_name not in existing:
            ddl = f"ALTER TABLE {table} ADD COLUMN {col_name} {col_type}"
            if default is not None:
                ddl += f" DEFAULT {default}"
            await conn.execute(text(ddl))
            logger.info("Migration: added column %s.%s", table, col_name)


async def init_db() -> None:
    """Create all tables and run lightweight migrations."""
    async with engine.begin() as conn:
        await conn.execute(text("PRAGMA foreign_keys=ON"))
        await conn.run_sync(Base.metadata.create_all)
        await _migrate_add_columns(conn)


async def get_db() -> AsyncSession:  # type: ignore[misc]
    """Yield a database session for dependency injection."""
    async with async_session_factory() as session:
        yield session
