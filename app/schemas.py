"""Request/response models shared across the pipeline."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class Caller(BaseModel):
    """The signed-in user who uploaded the image."""

    object_id: str
    name: str = ""
    username: str = ""
    tenant_id: str = ""
    scopes: list[str] = Field(default_factory=list)

    @property
    def label(self) -> str:
        parts = [p for p in (self.name, self.username) if p]
        return " ".join(parts) if parts else self.object_id


class ExtractionResult(BaseModel):
    """The one shape every extractor must return, whatever engine it uses."""

    is_package_label: bool = True
    receiver_name: str = ""
    department: str = ""
    client_info: str = ""
    tracking_number: str = ""
    item: str = ""
    confidence: float = 0.0

    # Provenance — not used for routing, useful when a result looks wrong.
    extractor: str = ""
    model: str = ""
    raw_text: str = ""
    latency_sec: float = 0.0


class AssigneeInfo(BaseModel):
    name: str
    user_id: str
    score: float | None = None
    source: str  # "receiver_match" | "department_default"


class RoutingResult(BaseModel):
    query: str
    department: str | None = None
    department_id: str | None = None
    bucket_id: str = ""
    score: float = 0.0
    resolved: bool = False
    fallback_reason: str | None = None
    assignee: AssigneeInfo | None = None


class UploadedFile(BaseModel):
    name: str
    web_url: str


class CreatedTask(BaseModel):
    id: str
    title: str
    bucket_id: str
    plan_id: str
    web_url: str


class IntakeResponse(BaseModel):
    status: str  # "created" | "rejected"
    reason: str | None = None
    uploaded_by: Caller | None = None
    extraction: ExtractionResult
    routing: RoutingResult | None = None
    file: UploadedFile | None = None
    task: CreatedTask | None = None


class ErrorResponse(BaseModel):
    detail: str
    context: dict[str, Any] = Field(default_factory=dict)
