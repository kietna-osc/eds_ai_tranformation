"""Entra ID access-token validation.

Only signed-in users of the tenant may call the API. This is about *who is
allowed to upload* — it is unrelated to how the service talks to Graph, which
stays app-only (see app/graph/client.py). The caller's identity is recorded on
the task, never used to call Graph.

Validation is done in-process rather than delegated to Container Apps built-in
auth so it behaves identically locally, in tests, and on any other host.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any

import httpx
import jwt
from fastapi import HTTPException, Request
from jwt.algorithms import RSAAlgorithm

from app.config import Settings
from app.schemas import Caller

log = logging.getLogger(__name__)

ALGORITHMS = ["RS256"]
_UNAUTHENTICATED = {"WWW-Authenticate": "Bearer"}


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(status_code=401, detail=detail, headers=_UNAUTHENTICATED)


class TokenValidator:
    """Validates bearer tokens against the tenant's published signing keys."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.tenant_id = settings.auth_tenant_id or settings.azure_tenant_id
        self.audiences = [
            a.strip() for a in settings.auth_audience.split(",") if a.strip()
        ]
        self.required_scopes = [
            s.strip() for s in settings.auth_required_scope.split(",") if s.strip()
        ]
        # Entra issues v2.0 tokens from login.microsoftonline.com and v1.0
        # tokens from sts.windows.net; both are legitimate for this tenant.
        self.issuers = {
            f"https://login.microsoftonline.com/{self.tenant_id}/v2.0",
            f"https://sts.windows.net/{self.tenant_id}/",
        }
        self._jwks_uri = (
            f"https://login.microsoftonline.com/{self.tenant_id}"
            "/discovery/v2.0/keys"
        )
        self._http = httpx.AsyncClient(timeout=10.0)
        self._keys: dict[str, Any] = {}
        self._fetched_at = 0.0

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _signing_key(self, kid: str) -> Any:
        """Keys are cached; an unknown kid forces one refresh (key rollover)."""
        expired = time.monotonic() - self._fetched_at > self.settings.auth_jwks_ttl_sec
        if kid not in self._keys or expired:
            await self._refresh_keys()
        key = self._keys.get(kid)
        if key is None:
            raise _unauthorized("Token signing key is not known to this tenant")
        return key

    async def _refresh_keys(self) -> None:
        try:
            response = await self._http.get(self._jwks_uri)
            response.raise_for_status()
            jwks = response.json()
        except Exception as e:
            log.error("failed to fetch JWKS from %s: %s", self._jwks_uri, e)
            raise HTTPException(
                status_code=503, detail="Cannot reach the identity provider"
            ) from e

        self._keys = {
            key["kid"]: RSAAlgorithm.from_jwk(json.dumps(key))
            for key in jwks.get("keys", [])
            if key.get("kid") and key.get("kty") == "RSA"
        }
        self._fetched_at = time.monotonic()
        log.info("loaded %d signing keys", len(self._keys))

    async def validate(self, token: str) -> Caller:
        try:
            kid = jwt.get_unverified_header(token).get("kid")
        except jwt.PyJWTError as e:
            raise _unauthorized(f"Malformed token: {e}") from e
        if not kid:
            raise _unauthorized("Token header has no key id")

        key = await self._signing_key(kid)
        try:
            claims = jwt.decode(
                token,
                key=key,
                algorithms=ALGORITHMS,
                audience=self.audiences,
                # Issuer is checked below so both v1.0 and v2.0 are accepted.
                options={"verify_iss": False, "require": ["exp", "aud"]},
            )
        except jwt.ExpiredSignatureError as e:
            raise _unauthorized("Token has expired") from e
        except jwt.InvalidAudienceError as e:
            raise _unauthorized("Token was not issued for this API") from e
        except jwt.PyJWTError as e:
            raise _unauthorized(f"Invalid token: {e}") from e

        if claims.get("iss") not in self.issuers:
            raise _unauthorized("Token was not issued by this tenant")
        if self.tenant_id and claims.get("tid") not in (None, self.tenant_id):
            raise _unauthorized("Token belongs to a different tenant")

        scopes = str(claims.get("scp") or "").split()
        if self.settings.auth_require_delegated and not scopes:
            # No `scp` means an app-only token: a daemon, not a signed-in user.
            raise _unauthorized("A signed-in user token is required")
        missing = [s for s in self.required_scopes if s not in scopes]
        if missing:
            raise HTTPException(
                status_code=403, detail=f"Token is missing scope(s): {missing}"
            )

        object_id = claims.get("oid") or claims.get("sub") or ""
        if not object_id:
            raise _unauthorized("Token identifies no user")

        return Caller(
            object_id=str(object_id),
            name=str(claims.get("name") or ""),
            username=str(
                claims.get("preferred_username") or claims.get("upn") or ""
            ),
            tenant_id=str(claims.get("tid") or ""),
            scopes=scopes,
        )


async def require_caller(request: Request) -> Caller:
    """FastAPI dependency: 401 unless the request carries a valid user token."""
    settings: Settings = request.app.state.settings
    if not settings.auth_enabled:
        # Explicit opt-out for local development only; see check_auth_config().
        return Caller(object_id="anonymous", name="auth disabled")

    header = request.headers.get("Authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise _unauthorized("Missing bearer token")

    validator: TokenValidator = request.app.state.token_validator
    caller = await validator.validate(token.strip())
    request.state.caller = caller
    return caller


def check_auth_config(settings: Settings) -> None:
    """Fail at startup rather than serve an unprotected API by accident."""
    if not settings.auth_enabled:
        log.warning(
            "AUTH_ENABLED=false - the API accepts unauthenticated requests. "
            "Never do this on external ingress."
        )
        return
    if not (settings.auth_tenant_id or settings.azure_tenant_id):
        raise RuntimeError("AUTH_TENANT_ID (or AZURE_TENANT_ID) must be set")
    if not settings.auth_audience:
        raise RuntimeError(
            "AUTH_AUDIENCE must be set to this API's application ID URI "
            "(e.g. api://<client-id>) or its client id"
        )
