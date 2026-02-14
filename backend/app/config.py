"""Application settings from environment variables."""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application configuration."""

    app_name: str = "HandwriteDiff"
    debug: bool = True
    database_url: str = "sqlite+aiosqlite:///./handwrite_diff.db"

    # Storage paths
    storage_dir: Path = Path("storage")
    upload_dir: Path = Path("storage/uploads")
    annotated_dir: Path = Path("storage/annotated")

    # CORS
    cors_origins: list[str] = ["http://localhost:3000"]

    # Gemini OCR settings (via OpenAI-compatible API)
    gemini_api_key: str = ""
    gemini_base_url: str = ""  # Required: OpenAI-compatible endpoint (e.g. https://yunwu.ai/v1)
    gemini_model: str = "gemini-2.5-flash"
    gemini_max_retries: int = 3
    gemini_retry_delay: float = 1.0  # Exponential backoff initial delay (seconds)
    gemini_temperature: float = 0.1  # Low temperature for OCR accuracy
    gemini_timeout: float = 120.0  # API request timeout (seconds)

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}

    def ensure_storage_dirs(self) -> None:
        """Create storage directories if they don't exist."""
        self.upload_dir.mkdir(parents=True, exist_ok=True)
        self.annotated_dir.mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    return Settings()
