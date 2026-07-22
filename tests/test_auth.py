"""Token validation, exercised with a locally generated signing key.

No network and no tenant: the validator's JWKS cache is primed directly, which
is the only thing these tests stub out.
"""

from __future__ import annotations

import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException

from app.auth import TokenValidator
from app.config import Settings

TENANT = "600ffa26-acce-4b8b-9b18-b17fbd397458"
AUDIENCE = "api://d63a4350-6432-4aeb-ac22-6fd463314fa8"
KID = "test-key"

PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
OTHER_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


def make_token(key=PRIVATE_KEY, kid: str = KID, **overrides) -> str:
    now = int(time.time())
    claims = {
        "iss": f"https://login.microsoftonline.com/{TENANT}/v2.0",
        "aud": AUDIENCE,
        "tid": TENANT,
        "oid": "6689dcdf-f9d5-4f99-af61-95d883b21924",
        "name": "Tong The Kiet",
        "preferred_username": "kiettt@SOSC613.onmicrosoft.com",
        "scp": "access_as_user",
        "iat": now,
        "nbf": now,
        "exp": now + 600,
    }
    claims.update(overrides)
    return jwt.encode(claims, key, algorithm="RS256", headers={"kid": kid})


@pytest.fixture
def validator() -> TokenValidator:
    settings = Settings(
        _env_file=None,
        azure_tenant_id=TENANT,
        auth_audience=AUDIENCE,
        auth_required_scope="access_as_user",
    )
    v = TokenValidator(settings)
    v._keys = {KID: PRIVATE_KEY.public_key()}
    v._fetched_at = time.monotonic()
    return v


async def test_valid_token_yields_the_caller(validator):
    caller = await validator.validate(make_token())
    assert caller.object_id == "6689dcdf-f9d5-4f99-af61-95d883b21924"
    assert caller.name == "Tong The Kiet"
    assert caller.username == "kiettt@SOSC613.onmicrosoft.com"
    assert caller.scopes == ["access_as_user"]


async def test_v1_issuer_is_accepted(validator):
    caller = await validator.validate(
        make_token(iss=f"https://sts.windows.net/{TENANT}/")
    )
    assert caller.object_id


async def _rejects(validator, token, status=401) -> str:
    with pytest.raises(HTTPException) as exc:
        await validator.validate(token)
    assert exc.value.status_code == status
    return str(exc.value.detail)


async def test_expired_token_is_rejected(validator):
    now = int(time.time())
    detail = await _rejects(validator, make_token(exp=now - 10, iat=now - 600))
    assert "expired" in detail.lower()


async def test_token_for_another_api_is_rejected(validator):
    await _rejects(validator, make_token(aud="api://some-other-app"))


async def test_token_from_another_tenant_is_rejected(validator):
    other = "11111111-2222-3333-4444-555555555555"
    await _rejects(
        validator,
        make_token(iss=f"https://login.microsoftonline.com/{other}/v2.0", tid=other),
    )


async def test_token_signed_by_an_unknown_key_is_rejected(validator):
    await _rejects(validator, make_token(key=OTHER_KEY))


async def test_unknown_kid_is_rejected_without_a_reachable_jwks(validator):
    # Refresh is attempted, fails offline, and must not fall through to accept.
    with pytest.raises(HTTPException) as exc:
        await validator.validate(make_token(kid="rotated-key"))
    assert exc.value.status_code in (401, 503)


async def test_app_only_token_is_rejected(validator):
    """Client-credential tokens carry `roles`, never `scp` - not a person."""
    detail = await _rejects(validator, make_token(scp=None, roles=["Tasks.ReadWrite.All"]))
    assert "signed-in user" in detail


async def test_missing_required_scope_is_forbidden(validator):
    await _rejects(validator, make_token(scp="openid profile"), status=403)


async def test_garbage_token_is_rejected(validator):
    await _rejects(validator, "not-a-jwt")
