"""Shared OpenAI-compatible chat client (OpenRouter, Azure OpenAI, ...)."""

from __future__ import annotations

from typing import Any

from openai import AsyncOpenAI

from app.config import Settings
from app.extractors.base import ExtractorError


def build_client(settings: Settings) -> AsyncOpenAI:
    if not settings.llm_api_key:
        raise ExtractorError("LLM_API_KEY is not set")
    kwargs: dict[str, Any] = {
        "base_url": settings.llm_base_url.rstrip("/"),
        "api_key": settings.llm_api_key,
        "timeout": settings.llm_timeout_sec,
    }
    if settings.llm_api_version:
        kwargs["default_query"] = {"api-version": settings.llm_api_version}
    return AsyncOpenAI(**kwargs)


async def chat_json(
    client: AsyncOpenAI, settings: Settings, messages: list[dict[str, Any]]
) -> str:
    """One JSON-mode completion; returns the raw content string."""
    try:
        response = await client.chat.completions.create(
            model=settings.llm_model,
            messages=messages,
            temperature=settings.llm_temperature,
            max_tokens=settings.llm_max_tokens,
            response_format={"type": "json_object"},
        )
    except Exception as e:
        raise ExtractorError(f"LLM call failed ({settings.llm_model}): {e}") from e
    return response.choices[0].message.content or ""
