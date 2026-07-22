"""Extractor contract + shared JSON handling.

Every extractor is a different route to the same destination:
    bytes -> ExtractionResult
Nothing downstream may branch on which one ran.
"""

from __future__ import annotations

import json
from abc import ABC, abstractmethod
from typing import Any

from app.schemas import ExtractionResult


class ExtractorError(RuntimeError):
    """Extraction could not be completed (bad config, upstream failure, bad output)."""


class Extractor(ABC):
    name: str = "base"

    @abstractmethod
    async def extract(self, image: bytes, content_type: str) -> ExtractionResult:
        """Return the common result shape, or raise ExtractorError."""


def parse_llm_json(content: str) -> dict[str, Any]:
    """Parse a model reply that should be a JSON object, tolerating code fences."""
    text = (content or "").strip()
    if text.startswith("```"):
        text = text.split("```")[1] if "```" in text[3:] else text.lstrip("`")
        text = text[4:] if text.lower().startswith("json") else text
    text = text.strip()
    if not text:
        raise ExtractorError("Model returned an empty response")
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as e:
        raise ExtractorError(f"Model did not return JSON: {e}") from e
    if not isinstance(parsed, dict):
        raise ExtractorError("Model returned JSON but not an object")
    return parsed


def _clean_str(value: Any) -> str:
    if value is None or isinstance(value, (dict, list)):
        return ""
    return str(value).strip()


def _clean_confidence(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    if number > 1.0:  # models sometimes answer 85 instead of 0.85
        number /= 100.0
    return max(0.0, min(1.0, number))


def build_result(
    payload: dict[str, Any],
    *,
    extractor: str,
    model: str,
    latency_sec: float,
    raw_text: str = "",
) -> ExtractionResult:
    """Normalise a model's JSON object into the common result shape."""
    return ExtractionResult(
        is_package_label=bool(payload.get("is_package_label", True)),
        receiver_name=_clean_str(payload.get("receiver_name")),
        department=_clean_str(payload.get("department")),
        client_info=_clean_str(payload.get("client_info") or payload.get("clientInfo")),
        tracking_number=_clean_str(
            payload.get("tracking_number") or payload.get("clientNumber")
        ),
        item=_clean_str(payload.get("item") or payload.get("clientItem")),
        confidence=_clean_confidence(payload.get("confidence")),
        extractor=extractor,
        model=model,
        raw_text=raw_text,
        latency_sec=round(latency_sec, 3),
    )
