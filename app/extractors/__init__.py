"""Extractors: image bytes in, one common ExtractionResult out."""

from __future__ import annotations

from app.config import Settings, get_settings
from app.extractors.base import Extractor, ExtractorError

__all__ = ["Extractor", "ExtractorError", "get_extractor", "AVAILABLE"]

AVAILABLE = ("vlm", "ocr_llm")

# Instances hold an HTTP client, so they are built once and reused.
_CACHE: dict[str, Extractor] = {}


def _build(name: str, settings: Settings) -> Extractor:
    if name == "vlm":
        from app.extractors.vlm import VlmExtractor

        return VlmExtractor(settings)
    if name == "ocr_llm":
        from app.extractors.ocr_llm import OcrLlmExtractor

        return OcrLlmExtractor(settings)
    raise ExtractorError(f"Unknown extractor {name!r}. Available: {AVAILABLE}")


def get_extractor(name: str | None = None, settings: Settings | None = None) -> Extractor:
    """Resolve an extractor by name, defaulting to the configured one."""
    settings = settings or get_settings()
    key = name or settings.extractor
    if key not in _CACHE:
        _CACHE[key] = _build(key, settings)
    return _CACHE[key]
