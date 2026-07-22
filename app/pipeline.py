"""The one flow this service exists for.

    image -> extraction -> routing -> upload -> Planner task

Extraction is pluggable; everything after it only sees ExtractionResult.
"""

from __future__ import annotations

import logging

from app.config import Settings
from app.directory import load_directory
from app.extractors import get_extractor
from app.graph import GraphClient
from app.graph.drive import safe_filename, upload_image
from app.graph.planner import attach_details, create_task
from app.routing import route
from app.schemas import Caller, IntakeResponse

log = logging.getLogger(__name__)


def _title(receiver_name: str, settings: Settings) -> str:
    name = receiver_name.strip() or settings.unknown_receiver_label
    return settings.task_title_template.format(receiver_name=name)


async def process_image(
    image: bytes,
    *,
    filename: str | None,
    content_type: str,
    graph: GraphClient,
    settings: Settings,
    caller: Caller | None = None,
    extractor_name: str | None = None,
) -> IntakeResponse:
    extractor = get_extractor(extractor_name, settings)
    extraction = await extractor.extract(image, content_type)
    log.info(
        "extracted uploader=%s extractor=%s department=%r receiver=%r "
        "confidence=%.2f in %.2fs",
        caller.object_id if caller else "-",
        extraction.extractor,
        extraction.department,
        extraction.receiver_name,
        extraction.confidence,
        extraction.latency_sec,
    )

    if not extraction.is_package_label:
        # Not a delivery slip - no task, but report what was seen.
        return IntakeResponse(
            status="rejected",
            reason="image is not a package label",
            uploaded_by=caller,
            extraction=extraction,
        )

    directory = load_directory(settings.directory_path)
    routing = route(extraction, directory, settings)
    if not routing.resolved:
        log.warning("routing fell back to default bucket: %s", routing.fallback_reason)

    group_id = await graph.get_plan_group_id(settings.plan_id)

    uploaded = await upload_image(
        graph,
        group_id,
        settings.upload_folder,
        safe_filename(filename),
        image,
    )

    task = await create_task(
        graph,
        plan_id=settings.plan_id,
        bucket_id=routing.bucket_id,
        title=_title(extraction.receiver_name, settings),
        assignee=routing.assignee,
        tenant_id=settings.azure_tenant_id,
    )

    # The task already exists at this point; a failure here loses the image
    # link, not the task, and the caller sees the error.
    await attach_details(graph, task.id, uploaded, extraction, caller)

    log.info(
        "task created id=%s bucket=%s assignee=%s uploader=%s",
        task.id,
        routing.bucket_id,
        routing.assignee.name if routing.assignee else "-",
        caller.object_id if caller else "-",
    )
    return IntakeResponse(
        status="created",
        uploaded_by=caller,
        extraction=extraction,
        routing=routing,
        file=uploaded,
        task=task,
    )
