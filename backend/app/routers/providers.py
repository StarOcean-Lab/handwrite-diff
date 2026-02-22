"""Model provider management API routes."""

import asyncio
import json
import logging
import os
import time

from fastapi import APIRouter, HTTPException
from sqlalchemy import select

from app.deps import DB
from app.models.model_provider import ModelProvider
from app.schemas.provider import (
    ProviderCreate,
    ProviderModelTestRequest,
    ProviderModelTestResult,
    ProviderResponse,
    ProviderTestRequest,
    ProviderTestResponse,
    ProviderUpdate,
    _mask_api_key,
    _parse_models,
)

logger = logging.getLogger("handwrite_diff.providers")

router = APIRouter(prefix="/api/v1/providers", tags=["providers"])


def _to_response(provider: ModelProvider) -> ProviderResponse:
    return ProviderResponse(
        id=provider.id,
        name=provider.name,
        base_url=provider.base_url,
        api_key_masked=_mask_api_key(provider.api_key),
        default_model=provider.default_model,
        models=_parse_models(provider.models_json, provider.default_model),
        is_default=provider.is_default,
        created_at=provider.created_at,
        updated_at=provider.updated_at,
    )


def _serialize_models(models: list[str], default_model: str) -> str:
    """Serialize model list to JSON, ensuring default_model is first."""
    ordered = [default_model] + [m for m in models if m != default_model]
    return json.dumps(ordered)


@router.get("", response_model=list[ProviderResponse])
async def list_providers(db: DB) -> list[ProviderResponse]:
    """List all model providers (api_key masked)."""
    result = await db.execute(
        select(ModelProvider).order_by(ModelProvider.created_at.asc())
    )
    providers = result.scalars().all()
    return [_to_response(p) for p in providers]


@router.post("", response_model=ProviderResponse, status_code=201)
async def create_provider(body: ProviderCreate, db: DB) -> ProviderResponse:
    """Create a new model provider."""
    # If this provider is set as default, clear existing defaults first
    if body.is_default:
        await _clear_defaults(db)

    provider = ModelProvider(
        name=body.name,
        base_url=body.base_url,
        api_key=body.api_key,
        default_model=body.default_model,
        models_json=_serialize_models(body.models, body.default_model),
        is_default=body.is_default,
    )
    db.add(provider)
    await db.commit()
    await db.refresh(provider)
    return _to_response(provider)


@router.get("/{provider_id}", response_model=ProviderResponse)
async def get_provider(provider_id: int, db: DB) -> ProviderResponse:
    """Get a single model provider."""
    provider = await db.get(ModelProvider, provider_id)
    if not provider:
        raise HTTPException(status_code=404, detail="Provider not found")
    return _to_response(provider)


@router.patch("/{provider_id}", response_model=ProviderResponse)
async def update_provider(
    provider_id: int, body: ProviderUpdate, db: DB
) -> ProviderResponse:
    """Update a model provider. Omit api_key to keep the existing key."""
    provider = await db.get(ModelProvider, provider_id)
    if not provider:
        raise HTTPException(status_code=404, detail="Provider not found")

    if body.name is not None:
        provider.name = body.name
    if body.base_url is not None:
        provider.base_url = body.base_url
    if body.api_key:  # Only update if non-empty
        provider.api_key = body.api_key
    if body.default_model is not None:
        provider.default_model = body.default_model
    if body.models is not None:
        provider.models_json = _serialize_models(body.models, provider.default_model)
    if body.is_default is not None:
        if body.is_default and not provider.is_default:
            await _clear_defaults(db)
        provider.is_default = body.is_default

    await db.commit()
    await db.refresh(provider)
    return _to_response(provider)


@router.delete("/{provider_id}", status_code=204)
async def delete_provider(provider_id: int, db: DB) -> None:
    """Delete a model provider. Associated tasks keep provider_id=NULL."""
    provider = await db.get(ModelProvider, provider_id)
    if not provider:
        raise HTTPException(status_code=404, detail="Provider not found")
    await db.delete(provider)
    await db.commit()


@router.post("/{provider_id}/set-default", response_model=ProviderResponse)
async def set_default_provider(provider_id: int, db: DB) -> ProviderResponse:
    """Set this provider as the default, clearing all other defaults."""
    provider = await db.get(ModelProvider, provider_id)
    if not provider:
        raise HTTPException(status_code=404, detail="Provider not found")

    await _clear_defaults(db)
    provider.is_default = True
    await db.commit()
    await db.refresh(provider)
    return _to_response(provider)


@router.post("/{provider_id}/test-models", response_model=list[ProviderModelTestResult])
async def test_provider_models(
    provider_id: int, body: ProviderModelTestRequest, db: DB
) -> list[ProviderModelTestResult]:
    """Test one or more models using the provider's stored base_url and api_key."""
    provider = await db.get(ModelProvider, provider_id)
    if not provider:
        raise HTTPException(status_code=404, detail="Provider not found")

    results: list[ProviderModelTestResult] = []
    for model in body.models:
        try:
            resp = await asyncio.wait_for(
                _do_test_connection(provider.base_url, provider.api_key, model),
                timeout=15.0,
            )
            results.append(ProviderModelTestResult(
                model=model,
                success=resp.success,
                message=resp.message,
                latency_ms=resp.latency_ms,
            ))
        except asyncio.TimeoutError:
            results.append(ProviderModelTestResult(
                model=model,
                success=False,
                message="Connection timed out after 15 seconds",
            ))
        except Exception as exc:
            results.append(ProviderModelTestResult(
                model=model,
                success=False,
                message=str(exc),
            ))
    return results


@router.post("/test", response_model=ProviderTestResponse)
async def test_provider_connection(body: ProviderTestRequest) -> ProviderTestResponse:
    """Test an API provider connection without saving. Times out after 15s."""
    try:
        return await asyncio.wait_for(
            _do_test_connection(body.base_url, body.api_key, body.model),
            timeout=15.0,
        )
    except asyncio.TimeoutError:
        return ProviderTestResponse(
            success=False,
            message="Connection timed out after 15 seconds",
        )
    except Exception as exc:
        logger.warning("Provider test failed: %s", exc)
        return ProviderTestResponse(success=False, message=str(exc))


# ------------------------------------------------------------------
# Internal helpers
# ------------------------------------------------------------------


async def _clear_defaults(db: DB) -> None:
    """Set is_default=False on all providers."""
    result = await db.execute(
        select(ModelProvider).where(ModelProvider.is_default.is_(True))
    )
    for p in result.scalars().all():
        p.is_default = False


async def _do_test_connection(
    base_url: str, api_key: str, model: str
) -> ProviderTestResponse:
    """Send a minimal API request and measure latency."""
    from openai import AsyncOpenAI

    # Normalize base_url
    url = base_url.rstrip("/")
    if not url.endswith("/v1"):
        url += "/v1"

    # Clear proxy vars for direct connection
    for var in ("ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"):
        os.environ.pop(var, None)

    client = AsyncOpenAI(api_key=api_key, base_url=url, timeout=15.0)
    start = time.monotonic()
    response = await client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": "Say OK"}],
        max_tokens=4,
    )
    elapsed_ms = (time.monotonic() - start) * 1000
    content = response.choices[0].message.content or ""
    return ProviderTestResponse(
        success=True,
        message=f"Connected successfully. Response: {content.strip()!r}",
        latency_ms=round(elapsed_ms, 1),
    )
