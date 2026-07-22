"""The API must be closed by default and open only where probes need it."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings

TENANT = "600ffa26-acce-4b8b-9b18-b17fbd397458"


@pytest.fixture
def client(monkeypatch) -> TestClient:
    monkeypatch.setenv("AUTH_ENABLED", "true")
    monkeypatch.setenv("AZURE_TENANT_ID", TENANT)
    monkeypatch.setenv("AUTH_AUDIENCE", "api://test-app")
    monkeypatch.setenv("PLAN_ID", "plan-1")
    get_settings.cache_clear()

    from app.main import app

    with TestClient(app) as c:
        yield c
    get_settings.cache_clear()


def test_health_endpoints_stay_open_for_probes(client):
    assert client.get("/health").status_code == 200


@pytest.mark.parametrize("path", ["/api/v1/config", "/api/v1/me"])
def test_api_requires_a_token(client, path):
    response = client.get(path)
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"


def test_upload_requires_a_token(client):
    response = client.post(
        "/api/v1/orders", files={"image": ("a.jpg", b"x", "image/jpeg")}
    )
    assert response.status_code == 401


def test_a_non_bearer_scheme_is_rejected(client):
    response = client.get("/api/v1/me", headers={"Authorization": "Basic abc"})
    assert response.status_code == 401


def test_a_valid_token_reaches_the_route(monkeypatch):
    """Proves the dependency is wired, not just that it says no."""
    import time

    from test_auth import AUDIENCE, KID, PRIVATE_KEY, TENANT as AUTH_TENANT, make_token

    monkeypatch.setenv("AUTH_ENABLED", "true")
    monkeypatch.setenv("AZURE_TENANT_ID", AUTH_TENANT)
    monkeypatch.setenv("AUTH_AUDIENCE", AUDIENCE)
    get_settings.cache_clear()

    from app.main import app

    with TestClient(app) as c:
        # Prime the JWKS cache so no tenant call is made.
        app.state.token_validator._keys = {KID: PRIVATE_KEY.public_key()}
        app.state.token_validator._fetched_at = time.monotonic()

        response = c.get(
            "/api/v1/me", headers={"Authorization": f"Bearer {make_token()}"}
        )

    assert response.status_code == 200
    assert response.json()["name"] == "Tong The Kiet"
    get_settings.cache_clear()


def test_startup_fails_when_auth_is_enabled_without_an_audience(monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "true")
    monkeypatch.setenv("AZURE_TENANT_ID", TENANT)
    monkeypatch.delenv("AUTH_AUDIENCE", raising=False)
    get_settings.cache_clear()

    from app.main import app

    with pytest.raises(RuntimeError, match="AUTH_AUDIENCE"):
        with TestClient(app):
            pass
    get_settings.cache_clear()
