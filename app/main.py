"""FastAPI entrypoint."""

from __future__ import annotations

import logging
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api import router
from app.auth import TokenValidator, check_auth_config
from app.config import get_settings
from app.graph import GraphClient

log = logging.getLogger(__name__)


def configure_logging(level: str) -> None:
    """Log to stdout only - container filesystems are ephemeral."""
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stdout,
        force=True,
    )
    logging.getLogger("azure.identity").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    configure_logging(settings.log_level)
    check_auth_config(settings)  # refuse to start misconfigured

    app.state.settings = settings
    # One credential + one connection pool for the process.
    app.state.graph = GraphClient(settings)
    app.state.token_validator = TokenValidator(settings)
    log.info(
        "started extractor=%s plan_id=%s auth=%s",
        settings.extractor,
        settings.plan_id or "(unset)",
        "entra" if settings.auth_enabled else "DISABLED",
    )
    try:
        yield
    finally:
        await app.state.graph.aclose()
        await app.state.token_validator.aclose()
        log.info("stopped")


app = FastAPI(
    title="EDS order intake",
    description="Upload a package-label image; get a Planner task with the image attached.",
    version="0.1.0",
    lifespan=lifespan,
)
app.include_router(router)


@app.get("/health", summary="Liveness - no external calls")
def health() -> dict:
    return {"status": "ok"}


@app.get("/health/ready", summary="Readiness - proves Graph auth and the plan resolve")
async def ready() -> dict:
    settings = get_settings()
    if not settings.plan_id:
        return {"status": "degraded", "detail": "PLAN_ID is not configured"}
    try:
        group_id = await app.state.graph.get_plan_group_id(settings.plan_id)
    except Exception as e:
        log.warning("readiness check failed: %s", e)
        return {"status": "degraded", "detail": str(e)[:500]}
    return {"status": "ok", "plan_id": settings.plan_id, "group_id": group_id}


def main() -> None:
    import uvicorn

    settings = get_settings()
    configure_logging(settings.log_level)
    uvicorn.run("app.main:app", host=settings.host, port=settings.port, reload=False)


if __name__ == "__main__":
    main()
