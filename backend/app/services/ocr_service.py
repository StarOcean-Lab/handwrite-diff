"""Gemini OCR wrapper — word-level bounding box extraction.

Uses Gemini models via OpenAI-compatible API for handwritten text recognition
with word-level bounding boxes. Works with any OpenAI-compatible proxy
(e.g. yunwu.ai).

Public interface:
  - OcrWord(text, bbox, confidence)
  - OcrResult(raw_text, words)
  - ProviderConfig(base_url, api_key, model)
  - async run_ocr(image_path, model=None, provider_config=None) -> OcrResult
"""

import asyncio
import base64
import json
import logging
import os
from dataclasses import dataclass
from pathlib import Path

from PIL import Image

from app.config import get_settings

logger = logging.getLogger("handwrite_diff.ocr")

# Per-(base_url, api_key) client cache — avoids reinitializing on every call
_client_cache: dict[tuple[str, str], object] = {}


@dataclass(frozen=True)
class OcrWord:
    """A single recognized word with bounding box."""
    text: str
    bbox: tuple[float, float, float, float]  # (x1, y1, x2, y2) in pixels
    confidence: float


@dataclass(frozen=True)
class OcrResult:
    """OCR result for a single image."""
    raw_text: str
    words: list[OcrWord]


@dataclass(frozen=True)
class ProviderConfig:
    """Provider-specific OCR configuration (overrides global settings)."""
    base_url: str
    api_key: str
    model: str


# -- System prompt for OCR --

_SYSTEM_PROMPT = (
    "You are a precise OCR system specialized in handwritten text recognition. "
    "Your task is to detect every handwritten word in the image and return them "
    "in reading order (top-to-bottom, left-to-right).\n\n"
    "Return a JSON object with a single key \"words\", whose value is an array. "
    "Each element must have:\n"
    "- \"text\": the exact word as written (DO NOT correct spelling or grammar)\n"
    "- \"box_2d\": bounding box as [y_min, x_min, y_max, x_max] normalized to 0-1000\n"
    "- \"confidence\": your confidence score from 0.0 to 1.0\n\n"
    "Important rules:\n"
    "- Preserve the original handwriting exactly, including misspellings\n"
    "- Each word should have its own bounding box\n"
    "- SKIP any word that has a deletion mark on it, such as a strikethrough line, "
    "a scribble-out, a cross-out, or any other mark that indicates the writer "
    "intentionally deleted or cancelled that word — do NOT include it in the output\n"
    "- Return {\"words\": []} if no handwritten text is found"
)

_USER_PROMPT = "Detect all handwritten words in this image with their bounding boxes."


def _get_client(base_url: str | None, api_key: str) -> object:
    """Return a cached AsyncOpenAI client for the given (base_url, api_key) pair.

    On first creation, clears SOCKS/HTTP proxy env vars so the connection
    goes directly to the relay endpoint.
    """
    cache_key = (base_url or "", api_key)
    if cache_key not in _client_cache:
        from openai import AsyncOpenAI

        # Clear proxy env vars — the API endpoint is itself a relay.
        for var in (
            "ALL_PROXY", "all_proxy",
            "HTTP_PROXY", "http_proxy",
            "HTTPS_PROXY", "https_proxy",
        ):
            val = os.environ.pop(var, "")
            if val:
                logger.info("Cleared %s for direct API connection", var)

        _client_cache[cache_key] = AsyncOpenAI(
            api_key=api_key,
            base_url=base_url,  # None = use OpenAI default
            timeout=get_settings().gemini_timeout,
        )
        logger.info(
            "OpenAI client initialized (base_url: %s)",
            base_url or "(default)",
        )

    return _client_cache[cache_key]


def _resolve_client_and_model(
    model: str | None,
    provider_config: ProviderConfig | None,
) -> tuple[object, str]:
    """Return (client, effective_model) based on provider config or global settings."""
    settings = get_settings()

    if provider_config is not None:
        # Normalize base_url
        url = provider_config.base_url.rstrip("/")
        if not url.endswith("/v1"):
            url += "/v1"
        client = _get_client(url, provider_config.api_key)
        effective_model = model or provider_config.model
    else:
        # Fall back to global settings
        base_url = settings.gemini_base_url or None
        if base_url and not base_url.rstrip("/").endswith("/v1"):
            base_url = base_url.rstrip("/") + "/v1"
        client = _get_client(base_url, settings.gemini_api_key)
        effective_model = model or settings.gemini_model

    return client, effective_model


def _convert_bbox(
    box_2d: list[int],
    img_width: int,
    img_height: int,
) -> tuple[float, float, float, float]:
    """Convert normalized bbox [y_min, x_min, y_max, x_max] (0-1000) to pixel (x1, y1, x2, y2)."""
    y_min, x_min, y_max, x_max = box_2d
    return (
        x_min / 1000.0 * img_width,
        y_min / 1000.0 * img_height,
        x_max / 1000.0 * img_width,
        y_max / 1000.0 * img_height,
    )


def _image_to_data_url(image_path: str) -> str:
    """Encode image as base64 data URL for OpenAI vision API."""
    ext = Path(image_path).suffix.lower()
    mime_map = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".bmp": "image/bmp",
    }
    mime_type = mime_map.get(ext, "image/jpeg")

    with open(image_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()

    return f"data:{mime_type};base64,{b64}"


async def _call_api_with_retry(
    image_path: str,
    model: str | None = None,
    provider_config: ProviderConfig | None = None,
) -> list[dict]:
    """Call OpenAI-compatible API with exponential backoff retry."""
    settings = get_settings()
    client, effective_model = _resolve_client_and_model(model, provider_config)

    data_url = _image_to_data_url(image_path)

    last_error: Exception | None = None
    for attempt in range(settings.gemini_max_retries):
        try:
            response = await client.chat.completions.create(  # type: ignore[attr-defined]
                model=effective_model,
                messages=[
                    {"role": "system", "content": _SYSTEM_PROMPT},
                    {
                        "role": "user",
                        "content": [
                            {"type": "image_url", "image_url": {"url": data_url}},
                            {"type": "text", "text": _USER_PROMPT},
                        ],
                    },
                ],
                temperature=settings.gemini_temperature,
                response_format={"type": "json_object"},
            )

            content = response.choices[0].message.content
            if not content:
                logger.warning("API returned empty content (attempt %d)", attempt + 1)
                return []

            parsed = json.loads(content)
            # Handle both {"words": [...]} and direct [...] formats
            if isinstance(parsed, list):
                return parsed
            if isinstance(parsed, dict) and "words" in parsed:
                return parsed["words"]
            logger.warning(
                "Unexpected response structure: %s",
                list(parsed.keys()) if isinstance(parsed, dict) else type(parsed),
            )
            return []

        except Exception as e:
            last_error = e
            if attempt < settings.gemini_max_retries - 1:
                delay = settings.gemini_retry_delay * (2 ** attempt)
                logger.warning(
                    "API error (attempt %d/%d): %s. Retrying in %.1fs...",
                    attempt + 1,
                    settings.gemini_max_retries,
                    str(e),
                    delay,
                )
                await asyncio.sleep(delay)
            else:
                logger.error(
                    "API failed after %d retries: %s",
                    settings.gemini_max_retries,
                    str(e),
                )

    raise RuntimeError(
        f"OCR API failed after {settings.gemini_max_retries} retries"
    ) from last_error


async def run_ocr(
    image_path: str,
    model: str | None = None,
    provider_config: ProviderConfig | None = None,
) -> OcrResult:
    """Run OCR asynchronously via OpenAI-compatible API.

    Args:
        image_path: Path to the image file.
        model: Optional model override. Falls back to provider_config.model
               or global settings if None.
        provider_config: Optional per-task provider configuration.
                         When provided, overrides global settings for
                         base_url and api_key.

    Returns OcrResult with the same interface as the previous Surya
    implementation, ensuring zero changes to downstream pipeline.
    """
    path = Path(image_path)
    if not path.exists():
        raise FileNotFoundError(f"Image not found: {image_path}")

    # Get image dimensions for bbox conversion
    with Image.open(path) as img:
        img_width, img_height = img.size

    # Call API
    raw_words = await _call_api_with_retry(
        str(path), model=model, provider_config=provider_config
    )

    # Convert to OcrWord with pixel-coordinate bboxes
    words: list[OcrWord] = []
    for w in raw_words:
        text = w.get("text", "").strip()
        if not text:
            continue
        box_2d = w.get("box_2d")
        confidence = w.get("confidence", 0.8)

        if box_2d and len(box_2d) == 4:
            bbox = _convert_bbox(box_2d, img_width, img_height)
        else:
            bbox = (0.0, 0.0, 0.0, 0.0)

        words.append(OcrWord(text=text, bbox=bbox, confidence=confidence))

    raw_text = " ".join(w.text for w in words)
    return OcrResult(raw_text=raw_text, words=words)
