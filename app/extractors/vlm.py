"""image -> vision model -> fields (one call)."""

from __future__ import annotations

import base64
import time

from app.config import Settings
from app.extractors.base import Extractor, build_result, parse_llm_json
from app.extractors.llm import build_client, chat_json
from app.extractors.prompts import VISION_PROMPT
from app.schemas import ExtractionResult


class VlmExtractor(Extractor):
    name = "vlm"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._client = None

    def _get_client(self):
        if self._client is None:
            self._client = build_client(self.settings)
        return self._client

    async def extract(self, image: bytes, content_type: str) -> ExtractionResult:
        mime = content_type if content_type.startswith("image/") else "image/jpeg"
        data_uri = f"data:{mime};base64,{base64.b64encode(image).decode('ascii')}"
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": VISION_PROMPT},
                    {"type": "image_url", "image_url": {"url": data_uri}},
                ],
            }
        ]

        start = time.monotonic()
        content = await chat_json(self._get_client(), self.settings, messages)
        latency = time.monotonic() - start

        return build_result(
            parse_llm_json(content),
            extractor=self.name,
            model=self.settings.llm_model,
            latency_sec=latency,
        )
