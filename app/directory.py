"""The department/employee table the router resolves against.

Kept in a YAML file rather than fetched from Graph: bucket ids and object
GUIDs are stable, and a static file keeps the request path free of extra
Graph round-trips. Swap `load_directory` for a Graph call if that changes.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import yaml
from pydantic import BaseModel, Field


class Employee(BaseModel):
    name: str
    user_id: str
    aliases: list[str] = Field(default_factory=list)

    @property
    def names(self) -> list[str]:
        return [self.name, *self.aliases]


class Department(BaseModel):
    id: str
    name: str
    bucket_id: str
    aliases: list[str] = Field(default_factory=list)
    default_assignee: str | None = None
    employees: list[Employee] = Field(default_factory=list)

    @property
    def names(self) -> list[str]:
        return [self.name, *self.aliases]

    def employee_by_id(self, user_id: str) -> Employee | None:
        return next((e for e in self.employees if e.user_id == user_id), None)


class Directory(BaseModel):
    fallback_bucket_id: str
    departments: list[Department] = Field(default_factory=list)


@lru_cache(maxsize=4)
def load_directory(path: Path) -> Directory:
    if not path.exists():
        raise FileNotFoundError(f"Directory file not found: {path}")
    with open(path, encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}
    directory = Directory.model_validate(raw)
    if not directory.departments:
        raise ValueError(f"No departments defined in {path}")
    return directory
