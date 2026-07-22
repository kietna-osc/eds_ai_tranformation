"""Create the Planner task and attach the image to it."""

from __future__ import annotations

from app.graph.client import GraphClient
from app.schemas import (
    AssigneeInfo,
    Caller,
    CreatedTask,
    ExtractionResult,
    UploadedFile,
)


def reference_key(url: str) -> str:
    """Planner uses the URL itself as an OData Open Type property name.

    OData forbids . : % @ # in property names, so they must be percent-encoded.
    urllib.parse.quote() cannot be used: it also encodes `/`, which Planner
    then rejects. `%` must be replaced first or it would double-encode the rest.
    """
    return (
        url.replace("%", "%25")
        .replace(":", "%3A")
        .replace(".", "%2E")
        .replace("@", "%40")
        .replace("#", "%23")
        .replace(" ", "%20")
    )


def _task_web_url(task_id: str, tenant_id: str) -> str:
    if tenant_id:
        return f"https://tasks.office.com/{tenant_id}/Home/Task/{task_id}"
    return f"https://tasks.office.com/Home/Task/{task_id}"


def _description(
    extraction: ExtractionResult, file: UploadedFile, caller: Caller | None
) -> str:
    lines = [
        f"Nguoi nhan   : {extraction.receiver_name or '-'}",
        f"Bo phan (OCR): {extraction.department or '-'}",
        f"Nguoi gui    : {extraction.client_info or '-'}",
        f"Ma van don   : {extraction.tracking_number or '-'}",
        f"Hang hoa     : {extraction.item or '-'}",
        "",
        f"Nguoi tai len: {caller.label if caller else '-'}",
        f"Anh: {file.name}",
        f"Extractor: {extraction.extractor} ({extraction.model}), "
        f"confidence {extraction.confidence:.2f}",
    ]
    return "\n".join(lines)


async def create_task(
    graph: GraphClient,
    *,
    plan_id: str,
    bucket_id: str,
    title: str,
    assignee: AssigneeInfo | None,
    tenant_id: str = "",
) -> CreatedTask:
    body: dict[str, object] = {
        "planId": plan_id,
        "bucketId": bucket_id,
        "title": title,
    }
    if assignee is not None:
        body["assignments"] = {
            assignee.user_id: {
                "@odata.type": "#microsoft.graph.plannerAssignment",
                "orderHint": " !",
            }
        }

    task = await graph.request("POST", "/planner/tasks", step="create task", json=body)
    task_id = task["id"]
    return CreatedTask(
        id=task_id,
        title=title,
        bucket_id=bucket_id,
        plan_id=plan_id,
        web_url=_task_web_url(task_id, tenant_id),
    )


async def attach_details(
    graph: GraphClient,
    task_id: str,
    file: UploadedFile,
    extraction: ExtractionResult,
    caller: Caller | None = None,
) -> None:
    """Set the description and link the uploaded image as an external reference.

    Task details are a separate resource and need a fresh etag per write, so
    this is always GET-then-PATCH.
    """
    details = await graph.request(
        "GET", f"/planner/tasks/{task_id}/details", step="read task details"
    )
    etag = details["@odata.etag"]

    await graph.request(
        "PATCH",
        f"/planner/tasks/{task_id}/details",
        step="attach image to task",
        headers={
            "If-Match": etag,
            "Prefer": "return=representation",
            "Content-Type": "application/json",
        },
        json={
            "description": _description(extraction, file, caller),
            "previewType": "reference",
            "references": {
                reference_key(file.web_url): {
                    "@odata.type": "microsoft.graph.plannerExternalReference",
                    "alias": file.name,
                    "type": "Other",
                    "previewPriority": " !",
                }
            },
        },
    )
