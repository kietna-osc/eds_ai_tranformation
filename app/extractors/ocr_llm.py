"""image -> Azure Document Intelligence -> LLM -> fields (two calls)."""

from __future__ import annotations

import time

from starlette.concurrency import run_in_threadpool

from app.config import Settings
from app.extractors.base import (
    Extractor,
    ExtractorError,
    build_result,
    parse_llm_json,
)
from app.extractors.llm import build_client, chat_json
from app.extractors.prompts import TEXT_PROMPT_TEMPLATE
from app.schemas import ExtractionResult


class OcrLlmExtractor(Extractor):
    name = "ocr_llm"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._llm = None
        self._di = None

    def _get_llm(self):
        if self._llm is None:
            self._llm = build_client(self.settings)
        return self._llm

    def _get_di(self):
        """The Document Intelligence SDK is sync-only; calls go to a threadpool."""
        if self._di is None:
            if not (self.settings.azure_di_endpoint and self.settings.azure_di_key):
                raise ExtractorError(
                    "AZURE_DI_ENDPOINT / AZURE_DI_KEY are required by the "
                    "'ocr_llm' extractor"
                )
            try:
                from azure.ai.documentintelligence import DocumentIntelligenceClient
                from azure.core.credentials import AzureKeyCredential
            except ImportError as e:  # optional dependency
                raise ExtractorError(
                    "azure-ai-documentintelligence is not installed "
                    "(install the 'ocr' extra)"
                ) from e
            self._di = DocumentIntelligenceClient(
                endpoint=self.settings.azure_di_endpoint,
                credential=AzureKeyCredential(self.settings.azure_di_key),
            )
        return self._di

    def _run_ocr(self, image: bytes, content_type: str) -> str:
        client = self._get_di()
        try:
            poller = client.begin_analyze_document(
                self.settings.azure_di_model_id,
                body=image,
                content_type=content_type or "application/octet-stream",
            )
            return poller.result().content or ""
        except Exception as e:
            raise ExtractorError(f"Document Intelligence failed: {e}") from e

    async def extract(self, image: bytes, content_type: str) -> ExtractionResult:
        start = time.monotonic()

        ocr_text = await run_in_threadpool(self._run_ocr, image, content_type)
        if not ocr_text.strip():
            raise ExtractorError("OCR returned no text")

        content = await chat_json(
            self._get_llm(),
            self.settings,
            [{"role": "user", "content": TEXT_PROMPT_TEMPLATE.format(ocr_text=ocr_text)}],
        )
        latency = time.monotonic() - start

        return build_result(
            parse_llm_json(content),
            extractor=self.name,
            model=f"{self.settings.azure_di_model_id}+{self.settings.llm_model}",
            latency_sec=latency,
            raw_text=ocr_text,
        )
