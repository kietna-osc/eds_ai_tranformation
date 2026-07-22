"""Pipeline wiring, with Graph and the extractor faked out."""

from __future__ import annotations

from typing import Any

import pytest

from app.config import Settings
from app.extractors.base import Extractor
from app.graph.drive import safe_filename
from app.graph.planner import reference_key
from app.pipeline import process_image
from app.schemas import Caller, ExtractionResult

CALLER = Caller(
    object_id="uploader-oid", name="Tu Anh Nguyen Duy", username="tuanh@example.com"
)
FILE_URL = "https://contoso.sharepoint.com/sites/eds/Shared Documents/DonHang/a.jpg"


class FakeExtractor(Extractor):
    name = "fake"

    def __init__(self, result: ExtractionResult) -> None:
        self.result = result

    async def extract(self, image: bytes, content_type: str) -> ExtractionResult:
        return self.result


class FakeGraph:
    """Records calls and answers with the shapes Graph really returns."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    async def get_plan_group_id(self, plan_id: str) -> str:
        return "group-1"

    async def request(
        self, method: str, path: str, *, step: str, headers=None, json=None, content=None
    ) -> dict[str, Any]:
        self.calls.append((step, path))
        if step == "upload image":
            return {"name": "a.jpg", "webUrl": FILE_URL}
        if step == "create task":
            self.task_body = json
            return {"id": "task-1"}
        if step == "read task details":
            return {"@odata.etag": 'W/"etag"'}
        if step == "attach image to task":
            self.details_body = json
            return {}
        raise AssertionError(f"unexpected step {step}")


@pytest.fixture
def settings(tmp_path) -> Settings:
    directory = tmp_path / "directory.yaml"
    directory.write_text(
        """
fallback_bucket_id: bucket-unknown
departments:
  - id: sales
    name: Sales
    bucket_id: bucket-sales
    employees:
      - name: Tong The Kiet
        user_id: user-kiet
""",
        encoding="utf-8",
    )
    return Settings(_env_file=None, plan_id="plan-1", directory_path=directory)


async def run(monkeypatch, settings, result: ExtractionResult) -> tuple:
    graph = FakeGraph()
    monkeypatch.setattr(
        "app.pipeline.get_extractor", lambda *a, **k: FakeExtractor(result)
    )
    response = await process_image(
        b"jpeg-bytes",
        filename="label.jpg",
        content_type="image/jpeg",
        graph=graph,  # type: ignore[arg-type]
        settings=settings,
        caller=CALLER,
    )
    return response, graph


async def test_happy_path_creates_and_attaches(monkeypatch, settings):
    response, graph = await run(
        monkeypatch,
        settings,
        ExtractionResult(
            department="Sales", receiver_name="Tong The Kiet", confidence=0.9
        ),
    )

    assert response.status == "created"
    assert response.routing.bucket_id == "bucket-sales"
    assert response.routing.assignee.user_id == "user-kiet"
    assert response.task.id == "task-1"
    assert response.file.web_url == FILE_URL
    assert [step for step, _ in graph.calls] == [
        "upload image",
        "create task",
        "read task details",
        "attach image to task",
    ]
    assert "user-kiet" in graph.task_body["assignments"]
    assert reference_key(FILE_URL) in graph.details_body["references"]
    # The uploader is recorded on the task and echoed back to the caller.
    assert CALLER.name in graph.details_body["description"]
    assert response.uploaded_by.object_id == "uploader-oid"


async def test_non_label_image_creates_nothing(monkeypatch, settings):
    response, graph = await run(
        monkeypatch, settings, ExtractionResult(is_package_label=False, confidence=0.9)
    )
    assert response.status == "rejected"
    assert response.task is None
    assert graph.calls == []


async def test_unresolved_department_still_creates_an_unassigned_task(
    monkeypatch, settings
):
    response, graph = await run(
        monkeypatch, settings, ExtractionResult(department="???", confidence=0.9)
    )
    assert response.status == "created"
    assert response.routing.bucket_id == "bucket-unknown"
    assert "assignments" not in graph.task_body


def test_reference_key_encodes_odata_specials_but_keeps_slashes():
    key = reference_key(FILE_URL)
    assert key.startswith("https%3A//")
    assert "%2E" in key and "%20" in key
    assert ":" not in key and " " not in key


def test_safe_filename_strips_illegal_characters():
    name = safe_filename("a/b:c*d.JPG")
    assert "/" not in name and ":" not in name and "*" not in name
    assert name.endswith(".JPG")
