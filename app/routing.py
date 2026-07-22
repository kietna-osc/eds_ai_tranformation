"""Map an extraction onto a Planner bucket + assignee.

Department decides the bucket. The receiver name only narrows down *who*
inside that department gets assigned — it never changes the bucket.
"""

from __future__ import annotations

import unicodedata

from rapidfuzz import fuzz

from app.config import Settings
from app.directory import Department, Directory
from app.schemas import AssigneeInfo, ExtractionResult, RoutingResult


def normalize(text: str) -> str:
    """NFKC-fold, drop all whitespace, lowercase — OCR is inconsistent about all three."""
    folded = unicodedata.normalize("NFKC", text or "").replace("　", "")
    return "".join(folded.split()).lower()


def _best_score(query: str, variants: list[str]) -> float:
    q = normalize(query)
    if not q:
        return 0.0
    scores = [fuzz.ratio(q, normalize(v)) for v in variants if normalize(v)]
    return float(max(scores)) if scores else 0.0


def _match_department(query: str, directory: Directory) -> tuple[Department | None, float]:
    best: Department | None = None
    best_score = 0.0
    for dept in directory.departments:
        score = _best_score(query, dept.names)
        if score > best_score:
            best, best_score = dept, score
    return best, round(best_score, 2)


def _match_assignee(
    receiver_name: str, dept: Department, min_score: float
) -> AssigneeInfo | None:
    best = None
    best_score = 0.0
    for employee in dept.employees:
        score = _best_score(receiver_name, employee.names)
        if score > best_score:
            best, best_score = employee, score

    if best is not None and best_score >= min_score:
        return AssigneeInfo(
            name=best.name,
            user_id=best.user_id,
            score=round(best_score, 2),
            source="receiver_match",
        )

    if dept.default_assignee:
        fallback = dept.employee_by_id(dept.default_assignee)
        return AssigneeInfo(
            name=fallback.name if fallback else dept.default_assignee,
            user_id=dept.default_assignee,
            source="department_default",
        )
    return None


def route(
    extraction: ExtractionResult, directory: Directory, settings: Settings
) -> RoutingResult:
    """Never fails: an unresolved extraction lands in the fallback bucket, unassigned."""
    query = extraction.department
    dept, score = _match_department(query, directory)

    reason: str | None = None
    if extraction.confidence < settings.min_confidence:
        reason = (
            f"extraction confidence {extraction.confidence:.2f} "
            f"< {settings.min_confidence:.2f}"
        )
    elif dept is None or score < settings.min_department_score:
        reason = (
            f"department {query!r} scored {score:.1f} "
            f"< {settings.min_department_score:.1f}"
        )

    if reason is not None:
        return RoutingResult(
            query=query,
            department=dept.name if dept else None,
            department_id=dept.id if dept else None,
            bucket_id=directory.fallback_bucket_id,
            score=score,
            resolved=False,
            fallback_reason=reason,
        )

    assert dept is not None
    return RoutingResult(
        query=query,
        department=dept.name,
        department_id=dept.id,
        bucket_id=dept.bucket_id,
        score=score,
        resolved=True,
        assignee=_match_assignee(
            extraction.receiver_name, dept, settings.min_employee_score
        ),
    )
