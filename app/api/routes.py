"""HTTP surface: one endpoint that runs the pipeline, plus introspection."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile

from app.auth import require_caller
from app.config import get_settings
from app.directory import load_directory
from app.extractors import AVAILABLE, ExtractorError
from app.graph import GraphClient, GraphError
from app.pipeline import process_image
from app.schemas import Caller, IntakeResponse

log = logging.getLogger(__name__)

# Every /api/v1 route requires a signed-in tenant user; /health does not.
router = APIRouter(prefix="/api/v1", dependencies=[Depends(require_caller)])

ALLOWED_TYPES = {"image/jpeg", "image/png", "image/webp", "image/heic", "image/tiff"}


def _graph(request: Request) -> GraphClient:
    graph: GraphClient | None = getattr(request.app.state, "graph", None)
    if graph is None:
        raise HTTPException(status_code=503, detail="Graph client is not initialised")
    return graph


@router.post(
    "/orders",
    response_model=IntakeResponse,
    summary="Upload a package-label image and create the Planner task",
)
async def create_order(
    request: Request,
    image: UploadFile = File(..., description="Photo/scan of the delivery slip"),
    extractor: str | None = Form(
        default=None, description=f"Override the extractor: {', '.join(AVAILABLE)}"
    ),
    caller: Caller = Depends(require_caller),
) -> IntakeResponse:
    settings = get_settings()

    if not settings.plan_id:
        raise HTTPException(status_code=500, detail="PLAN_ID is not configured")
    if extractor is not None and extractor not in AVAILABLE:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown extractor {extractor!r}. Available: {list(AVAILABLE)}",
        )

    content_type = (image.content_type or "").lower()
    if content_type and content_type not in ALLOWED_TYPES:
        raise HTTPException(
            status_code=415, detail=f"Unsupported image type: {content_type}"
        )

    content = await image.read()
    if not content:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")
    if len(content) > settings.max_upload_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"Image exceeds {settings.max_upload_bytes} bytes",
        )

    try:
        return await process_image(
            content,
            filename=image.filename,
            content_type=content_type or "image/jpeg",
            graph=_graph(request),
            settings=settings,
            caller=caller,
            extractor_name=extractor,
        )
    except ExtractorError as e:
        log.error("extraction failed: %s", e)
        raise HTTPException(status_code=502, detail=f"Extraction failed: {e}") from e
    except GraphError as e:
        log.error("graph failed: %s", e)
        # 401/403 are our own configuration problems, not the caller's.
        status = 502 if e.status_code < 500 else 504
        raise HTTPException(status_code=status, detail=str(e)) from e


@router.get("/me", summary="Echo the caller's verified identity")
def whoami(caller: Caller = Depends(require_caller)) -> Caller:
    """Lets a frontend confirm its token wiring without uploading anything."""
    return caller


@router.get("/config", summary="Effective routing config (no secrets)")
def read_config() -> dict:
    settings = get_settings()
    directory = load_directory(settings.directory_path)
    return {
        "extractor": settings.extractor,
        "extractors_available": list(AVAILABLE),
        "llm_model": settings.llm_model,
        "plan_id": settings.plan_id,
        "upload_folder": settings.upload_folder,
        "thresholds": {
            "min_confidence": settings.min_confidence,
            "min_department_score": settings.min_department_score,
            "min_employee_score": settings.min_employee_score,
        },
        "fallback_bucket_id": directory.fallback_bucket_id,
        "departments": [
            {
                "id": d.id,
                "name": d.name,
                "bucket_id": d.bucket_id,
                "employees": [e.name for e in d.employees],
            }
            for d in directory.departments
        ],
    }
