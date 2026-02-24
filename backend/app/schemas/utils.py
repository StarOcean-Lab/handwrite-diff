"""Shared Pydantic utilities for schema definitions."""

from datetime import datetime, timezone
from typing import Annotated

from pydantic import BeforeValidator


def _ensure_utc(v: datetime) -> datetime:
    """Treat naive datetimes (as stored by SQLite) as UTC."""
    if isinstance(v, datetime) and v.tzinfo is None:
        return v.replace(tzinfo=timezone.utc)
    return v


# Use this type for all created_at / updated_at fields so Pydantic
# serialises them as "2026-02-24T10:17:36+00:00" instead of bare ISO,
# allowing browsers to correctly convert UTC → local time.
UTCDatetime = Annotated[datetime, BeforeValidator(_ensure_utc)]
