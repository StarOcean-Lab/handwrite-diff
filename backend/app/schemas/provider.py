"""Pydantic schemas for ModelProvider."""

import json
from datetime import datetime

from pydantic import BaseModel, Field


def _mask_api_key(key: str) -> str:
    """Return a masked version of the API key for display."""
    if len(key) <= 8:
        return "***"
    return key[:4] + "***" + key[-4:]


def _parse_models(models_json: str | None, default_model: str) -> list[str]:
    """Deserialize models_json; always include default_model."""
    try:
        models: list[str] = json.loads(models_json) if models_json else []
    except (ValueError, TypeError):
        models = []
    # Ensure default_model is always present
    if default_model and default_model not in models:
        models = [default_model] + models
    return models


class ProviderCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    base_url: str = Field(..., min_length=1, max_length=500)
    api_key: str = Field(..., min_length=1)
    default_model: str = Field(..., min_length=1, max_length=100)
    models: list[str] = Field(default_factory=list)
    is_default: bool = False


class ProviderUpdate(BaseModel):
    name: str | None = Field(None, max_length=100)
    base_url: str | None = Field(None, max_length=500)
    api_key: str | None = None  # empty / None = keep existing key
    default_model: str | None = Field(None, max_length=100)
    models: list[str] | None = None
    is_default: bool | None = None


class ProviderResponse(BaseModel):
    id: int
    name: str
    base_url: str
    api_key_masked: str
    default_model: str
    models: list[str]
    is_default: bool
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class ProviderTestRequest(BaseModel):
    base_url: str = Field(..., min_length=1)
    api_key: str = Field(..., min_length=1)
    model: str = Field(..., min_length=1)


class ProviderTestResponse(BaseModel):
    success: bool
    message: str
    latency_ms: float | None = None


class ProviderModelTestRequest(BaseModel):
    """Test multiple models using a provider's stored credentials."""
    models: list[str] = Field(..., min_length=1)


class ProviderModelTestResult(BaseModel):
    model: str
    success: bool
    message: str
    latency_ms: float | None = None
