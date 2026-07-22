"""Routing must never drop a task, and must never guess a bucket."""

from __future__ import annotations

from app.config import Settings
from app.directory import Directory
from app.routing import route
from app.schemas import ExtractionResult

DIRECTORY = Directory.model_validate(
    {
        "fallback_bucket_id": "bucket-unknown",
        "departments": [
            {
                "id": "sales",
                "name": "Sales",
                "aliases": ["営業部"],
                "bucket_id": "bucket-sales",
                "default_assignee": "user-kiet",
                "employees": [
                    {"name": "Tong The Kiet", "user_id": "user-kiet"},
                    {"name": "Dang Phuong Dung", "user_id": "user-dung"},
                ],
            },
            {
                "id": "rnd",
                "name": "RnD",
                "bucket_id": "bucket-rnd",
                "employees": [{"name": "Dang Quang Vinh", "user_id": "user-vinh"}],
            },
        ],
    }
)

SETTINGS = Settings(_env_file=None)


def extraction(**kwargs) -> ExtractionResult:
    return ExtractionResult(**{"confidence": 0.9, **kwargs})


def test_alias_and_whitespace_are_matched():
    result = route(extraction(department=" 営 業 部 "), DIRECTORY, SETTINGS)
    assert result.resolved
    assert result.bucket_id == "bucket-sales"


def test_receiver_name_picks_the_employee():
    result = route(
        extraction(department="Sales", receiver_name="Dang Phuong Dung"),
        DIRECTORY,
        SETTINGS,
    )
    assert result.assignee is not None
    assert result.assignee.user_id == "user-dung"
    assert result.assignee.source == "receiver_match"


def test_unknown_receiver_falls_back_to_the_department_default():
    result = route(
        extraction(department="Sales", receiver_name="Someone Else"),
        DIRECTORY,
        SETTINGS,
    )
    assert result.assignee is not None
    assert result.assignee.user_id == "user-kiet"
    assert result.assignee.source == "department_default"


def test_department_without_default_leaves_the_task_unassigned():
    result = route(
        extraction(department="RnD", receiver_name="Nobody"), DIRECTORY, SETTINGS
    )
    assert result.resolved
    assert result.assignee is None


def test_unmatched_department_goes_to_the_fallback_bucket():
    result = route(extraction(department="Marketing"), DIRECTORY, SETTINGS)
    assert not result.resolved
    assert result.bucket_id == "bucket-unknown"
    assert result.assignee is None
    assert result.fallback_reason


def test_low_confidence_goes_to_the_fallback_bucket_even_on_an_exact_name():
    result = route(
        ExtractionResult(department="Sales", confidence=0.1), DIRECTORY, SETTINGS
    )
    assert not result.resolved
    assert result.bucket_id == "bucket-unknown"
