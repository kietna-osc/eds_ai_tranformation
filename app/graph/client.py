"""Authenticated Graph transport.

One credential and one HTTP client for the whole process — both are built in
the app lifespan and reused, so tokens stay cached and connections are pooled.

Auth is DefaultAzureCredential: it picks up AZURE_CLIENT_ID/SECRET/TENANT_ID
locally and the container's managed identity in Azure, with no code change.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx
from azure.identity.aio import DefaultAzureCredential

from app.config import Settings

log = logging.getLogger(__name__)


class GraphError(RuntimeError):
    """A Graph call returned a non-2xx response."""

    def __init__(self, step: str, status_code: int, body: str) -> None:
        super().__init__(f"{step} failed - HTTP {status_code}: {body[:800]}")
        self.step = step
        self.status_code = status_code
        self.body = body


class GraphClient:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.base_url = settings.graph_base_url.rstrip("/")
        self._credential = DefaultAzureCredential()
        self._http = httpx.AsyncClient(timeout=settings.graph_timeout_sec)
        self._group_ids: dict[str, str] = {}

    async def aclose(self) -> None:
        await self._http.aclose()
        await self._credential.close()

    async def _auth_header(self) -> dict[str, str]:
        # The credential caches the token and refreshes it near expiry.
        token = await self._credential.get_token(self.settings.graph_scope)
        return {"Authorization": f"Bearer {token.token}"}

    async def request(
        self,
        method: str,
        path: str,
        *,
        step: str,
        headers: dict[str, str] | None = None,
        json: Any = None,
        content: bytes | None = None,
    ) -> dict[str, Any]:
        url = path if path.startswith("http") else f"{self.base_url}{path}"
        merged = {**await self._auth_header(), **(headers or {})}

        response = await self._http.request(
            method, url, headers=merged, json=json, content=content
        )
        if response.status_code >= 400:
            log.error(
                "graph call failed step=%s status=%s body=%s",
                step,
                response.status_code,
                response.text[:2000],
            )
            raise GraphError(step, response.status_code, response.text)
        if not response.content:
            return {}
        return response.json()

    async def get_plan_group_id(self, plan_id: str) -> str:
        """Planner plans live in an M365 group; the group owns the drive we upload to.

        A plan never changes container, so the lookup is cached for the
        process lifetime.
        """
        if plan_id in self._group_ids:
            return self._group_ids[plan_id]

        plan = await self.request(
            "GET", f"/planner/plans/{plan_id}", step="read plan"
        )
        container = plan.get("container") or {}
        group_id = container.get("containerId")
        if container.get("type") != "group" or not group_id:
            raise GraphError(
                "read plan",
                400,
                f"Plan {plan_id} is not owned by an M365 group "
                f"(container type={container.get('type')!r}); "
                "app-only permissions cannot reach it.",
            )
        self._group_ids[plan_id] = str(group_id)
        return str(group_id)
