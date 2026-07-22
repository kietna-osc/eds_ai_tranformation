# EDS order intake

Upload a photo of a delivery slip → a Planner task is created in the right
bucket, assigned to the right person, with the image attached.

```
POST /api/v1/orders   (multipart: image)
      │
      ├─ extractor      image ──► fields            (pluggable, one result shape)
      ├─ routing        department ──► bucket
      │                 receiver_name ──► assignee
      ├─ Graph drive    image ──► group document library
      └─ Graph planner  task + assignment + image reference
```

## Endpoints

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/api/v1/orders` | Entra ID | `multipart/form-data`: `image` (required), `extractor` (optional override) |
| GET | `/api/v1/me` | Entra ID | echoes the verified caller — use it to check token wiring |
| GET | `/api/v1/config` | Entra ID | effective routing config, no secrets |
| GET | `/health` | open | liveness, no external calls |
| GET | `/health/ready` | open | readiness — proves Graph auth works and the plan resolves |

`POST /api/v1/orders` answers `200` with `status: "created"` and the task, or
`status: "rejected"` when the image is not a package label (nothing is created).
`4xx` means the request was bad; `5xx` means extraction or Graph failed.

## Authentication

Two unrelated identities:

- **Uploader → this API**: an Entra ID access token is required on every
  `/api/v1/*` call (`app/auth.py`). The token's signature, audience, issuer,
  tenant and expiry are verified against the tenant's published keys; app-only
  tokens are rejected, so an upload always comes from a person. The verified
  caller is written into the task description and returned as `uploaded_by`.
- **This API → Graph**: always app-only, whoever uploaded. Uploaders need no
  Planner permission of their own.

The service refuses to start with `AUTH_ENABLED=true` and no `AUTH_AUDIENCE`,
so it cannot be deployed unprotected by accident. `AUTH_ENABLED=false` is for
local development only and logs a warning on every start.

Entra setup, once:

```bash
# 1. App registration for THIS API (separate from the Graph app registration)
az ad app create --display-name eds-order-intake-api
az ad app update --id <api-app-id> --identifier-uris api://<api-app-id>
#    then add a scope named access_as_user (Portal: Expose an API)

# 2. The client app (SPA/Teams/desktop) requests that scope and sends the
#    resulting access token as:  Authorization: Bearer <token>
```

Set `AUTH_AUDIENCE=api://<api-app-id>` (add `,<api-app-id>` if some clients
send the bare-guid audience form) and `AUTH_REQUIRED_SCOPE=access_as_user`.

## Extractors

Both produce the identical `ExtractionResult`; nothing downstream knows which ran.

| `EXTRACTOR` | Flow | Needs |
| --- | --- | --- |
| `vlm` (default) | image → vision model → fields | `LLM_*` |
| `ocr_llm` | image → Azure Document Intelligence → text → LLM → fields | `LLM_*`, `AZURE_DI_*`, `pip install .[ocr]` |

To add a third, subclass `Extractor` in `app/extractors/`, return
`build_result(...)`, and register the name in `app/extractors/__init__.py`.
Nothing else changes.

## Routing

`config/directory.yaml` maps departments → bucket ids and lists each
department's members. Matching is fuzzy (NFKC-folded, whitespace-stripped) so
OCR spacing and full-width characters do not matter, and `aliases` cover the
Japanese spellings of the same unit.

Rules, in order:

1. Extraction confidence below `MIN_CONFIDENCE`, or department score below
   `MIN_DEPARTMENT_SCORE` → `fallback_bucket_id`, unassigned.
2. Otherwise the department's bucket; `receiver_name` scoring above
   `MIN_EMPLOYEE_SCORE` picks the assignee, else `default_assignee`, else
   the task is created unassigned.

Nothing is ever dropped — an unroutable slip becomes a visible task in the
fallback bucket.

## Run locally

```bash
cp .env.example .env      # fill AZURE_*, PLAN_ID, LLM_API_KEY
uv venv .venv && uv pip install --python .venv -e ".[dev]"
.venv/Scripts/python.exe -m app.main          # Linux/macOS: python -m app.main
```

```bash
curl http://localhost:8000/health/ready
TOKEN=$(az account get-access-token --resource api://<api-app-id> --query accessToken -o tsv)
curl -H "Authorization: Bearer $TOKEN" http://localhost:8000/api/v1/me
curl -H "Authorization: Bearer $TOKEN" \
     -X POST http://localhost:8000/api/v1/orders -F "image=@sample.jpg"
```

Docs at <http://localhost:8000/docs>.

```bash
.venv/Scripts/python.exe -m pytest -q          # no network, no credentials needed
```

## Configuration

Every field in `app/config.py` is an environment variable of the same name
(case-insensitive). See `.env.example`. Secrets are never returned by any
endpoint or written to logs.

## Deploy to Azure Container Apps

```bash
cp .env.example .env    # fill in AZURE_*, PLAN_ID, LLM_API_KEY, AUTH_AUDIENCE, ACR_NAME
./deploy.sh
```

`deploy.sh` reads `.env`, creates the resource group / registry / container app
if they are missing, builds the image in ACR (no local Docker needed), stores
`AZURE_CLIENT_SECRET` and `LLM_API_KEY` as Container App secrets rather than
plain env vars, rolls out the revision and smoke-tests `/health/ready`. Re-run
it to redeploy — bump `IMAGE_TAG` first, since Container Apps will not re-pull
an unchanged tag.

The image is deliberately small — no torch, no OpenCV; extraction is done by
hosted models.

<details>
<summary>The same steps by hand</summary>

```bash
az acr build -r <registry> -t eds-order-intake:latest .

az containerapp create \
  -n eds-order-intake -g <rg> --environment <env> \
  --image <registry>.azurecr.io/eds-order-intake:latest \
  --target-port 8000 --ingress external \
  --user-assigned <user-assigned-identity-resource-id> \
  --secrets llm-key=<...> \
  --env-vars PLAN_ID=<...> AZURE_TENANT_ID=<...> \
             AZURE_CLIENT_ID=<uami-client-id> \
             AUTH_AUDIENCE=api://<api-app-id> \
             AUTH_REQUIRED_SCOPE=access_as_user \
             LLM_API_KEY=secretref:llm-key
```

</details>

Ingress can stay `external`: the API is closed to anyone without a tenant
token. Only `/health` and `/health/ready` answer unauthenticated, and neither
returns configuration or secrets.

Auth is `DefaultAzureCredential`: locally it uses
`AZURE_TENANT_ID`/`AZURE_CLIENT_ID`/`AZURE_CLIENT_SECRET`; in Container Apps,
setting `AZURE_CLIENT_ID` to a user-assigned managed identity is enough — no
code change, no secret to rotate.

Graph app-only permissions required (admin consent):
`Tasks.ReadWrite.All`, `Group.ReadWrite.All`, `Files.ReadWrite.All`.
These cannot be granted to a managed identity in the portal; use
`New-MgServicePrincipalAppRoleAssignment`.

Point the Container Apps health probes at `/health` (liveness) and
`/health/ready` (readiness).
