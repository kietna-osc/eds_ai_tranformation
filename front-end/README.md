# EDS Front-end

Mobile-first **web** reception app for package intake. Hosted on **Azure Static Web Apps**.

Stack: Vite + React 19 + TypeScript + React Router + MSAL.

## Features

- Microsoft Entra ID sign-in / sign-out (MSAL)
- Capture / upload shipping label (Bearer token attached to API calls)
- Call `ai-service` OCR + fuzzy match (`/api/v1/eds/process`)
- Confirm & Send to **Microsoft Planner**
- Review candidates via Suggested / Search tabs, or store in **unknown list**
- Admin unknown list + assign recipient → Planner notify

## Local run

```bash
cd front-end
cp .env.example .env.local   # set VITE_AZURE_AD_* + AI_SERVICE_PROXY_TARGET
npm install
npm run dev
```

Open SWA URL (Vite proxies `/api/v1` → backend).

### Entra ID (login)

1. App registration → **SPA** redirect URI - SWA URL later.
2. Expose an API scope, e.g. `api://<client-id>/access_as_user`, and grant the SPA access.
3. Front-end env: `VITE_AZURE_AD_CLIENT_ID`, `VITE_AZURE_AD_TENANT_ID`, optional `VITE_AZURE_AD_API_SCOPE`.
4. ai-service env: `AZURE_AD_TENANT_ID`, `AZURE_AD_AUDIENCE=<API client id GUID>`, `EDS_REQUIRE_AUTH=true`.

Without `VITE_AZURE_AD_*`, the UI skips login (dev). Without `AZURE_AD_AUDIENCE`, the API skips token checks.

## Env

| Variable | When | Purpose |
|----------|------|---------|
| `AI_SERVICE_PROXY_TARGET` | Local `npm run dev` only | Vite proxy target for `/api/v1` (not baked into the browser bundle) |
| `VITE_AI_SERVICE_URL` | SWA / production build | Absolute AI service base URL (baked in at `npm run build`) |
| `VITE_AZURE_AD_CLIENT_ID` | Always (prod) | Entra SPA application (client) ID |
| `VITE_AZURE_AD_TENANT_ID` | Always (prod) | Entra tenant ID |
| `VITE_AZURE_AD_API_SCOPE` | Optional | Default `api://{CLIENT_ID}/access_as_user` |

See `.env.example`.

---

## Azure Static Web Apps

Deploy this Vite SPA to **Azure Static Web Apps (SWA)**. The API stays on **Azure Container Apps** — see [`../ai-service/docs/AZURE_CONTAINER_APPS.md`](../ai-service/docs/AZURE_CONTAINER_APPS.md).

### Build settings (important)

| Setting | Value |
|---------|--------|
| App location | `apps/front-end` |
| Output location | `dist` |
| App build command | `npm run build` |
| API location | *(leave empty — API is ACA, not SWA Functions)* |

SPA fallback is defined in `staticwebapps.config.json` (copied into `dist` via `public/`).

### Prerequisites

- Azure CLI (`az`) logged in: `az login`
- Resource group + subscription access
- `ai-service` already deployed on Container Apps (HTTPS FQDN)
- Entra ID app registration with SPA platform enabled
- GitHub repo connected **or** SWA CLI for manual deploy

Suggested names:

```bash
export SUBSCRIPTION_ID="<your-subscription-id>"
export LOCATION="japaneast"
export RG="rg-eds"
export SWA_NAME="eds-front-end"
export AI_SERVICE_FQDN="https://ai-service.YOUR-ENV.japaneast.azurecontainerapps.io"
```

```bash
az account set --subscription "$SUBSCRIPTION_ID"
az group create --name "$RG" --location "$LOCATION"
```

### 1. Create the Static Web App

**Option A — GitHub Actions (recommended)**

```bash
az staticwebapp create \
  --name "$SWA_NAME" \
  --resource-group "$RG" \
  --location "$LOCATION" \
  --sku Free \
  --source https://github.com/<org>/<repo> \
  --branch main \
  --app-location "apps/front-end" \
  --output-location "dist" \
  --login-with-github
```

Azure creates a GitHub Actions workflow and deploys on every push to the branch.

**Option B — SWA resource only (manual / CLI deploy)**

```bash
az staticwebapp create \
  --name "$SWA_NAME" \
  --resource-group "$RG" \
  --location "$LOCATION" \
  --sku Free
```

Get the hostname and deploy token:

```bash
az staticwebapp show \
  --name "$SWA_NAME" \
  --resource-group "$RG" \
  --query "defaultHostname" -o tsv

az staticwebapp secrets list \
  --name "$SWA_NAME" \
  --resource-group "$RG" \
  --query "properties.apiKey" -o tsv
```

### 2. Build-time environment variables

`VITE_*` values are **compiled into the JS bundle** at build time. Set them as SWA **Application settings** (GitHub Actions injects them into the build job) or export them before a local `npm run build`.

```bash
az staticwebapp appsettings set \
  --name "$SWA_NAME" \
  --resource-group "$RG" \
  --setting-names \
    VITE_AI_SERVICE_URL="$AI_SERVICE_FQDN" \
    VITE_AZURE_AD_CLIENT_ID="<entra-spa-client-id>" \
    VITE_AZURE_AD_TENANT_ID="<entra-tenant-id>"
# Optional:
#   VITE_AZURE_AD_API_SCOPE="api://<client-id>/access_as_user"
```

If you use the generated GitHub workflow, also add the same keys under the repo **Actions secrets / variables** that the workflow passes into the build step (or rely on SWA app settings if the workflow is configured to use them).

Example GitHub Actions build step env:

```yaml
- name: Build And Deploy
  uses: Azure/static-web-apps-deploy@v1
  with:
    azure_static_web_apps_api_token: ${{ secrets.AZURE_STATIC_WEB_APPS_API_TOKEN }}
    repo_token: ${{ secrets.GITHUB_TOKEN }}
    action: "upload"
    app_location: "apps/front-end"
    output_location: "dist"
  env:
    VITE_AI_SERVICE_URL: ${{ vars.VITE_AI_SERVICE_URL }}
    VITE_AZURE_AD_CLIENT_ID: ${{ vars.VITE_AZURE_AD_CLIENT_ID }}
    VITE_AZURE_AD_TENANT_ID: ${{ vars.VITE_AZURE_AD_TENANT_ID }}
    VITE_AZURE_AD_API_SCOPE: ${{ vars.VITE_AZURE_AD_API_SCOPE }}
```

### 3. Deploy with SWA CLI (optional, no GitHub)

```bash
cd apps/front-end
npm install

export VITE_AI_SERVICE_URL="$AI_SERVICE_FQDN"
export VITE_AZURE_AD_CLIENT_ID="<entra-spa-client-id>"
export VITE_AZURE_AD_TENANT_ID="<entra-tenant-id>"

npm run build

npx @azure/static-web-apps-cli deploy ./dist \
  --deployment-token "<deployment-token-from-step-1>" \
  --env production
```

### 4. Wire Entra ID + CORS

After the first deploy, note the SWA URL:

```text
https://<defaultHostname>          # e.g. https://happy-xxx.azurestaticapps.net
```

1. **Entra** → App registration → **Authentication** → SPA redirect URIs, add:
   - `https://<defaultHostname>`
   - `http://localhost:5173` (keep for local)
2. **ai-service** (Container Apps) env — include the SWA origin:

```bash
# Example: update CORS on the existing container app
az containerapp update \
  --name ai-service \
  --resource-group "$RG" \
  --set-env-vars \
    "CORS_ORIGINS=https://<defaultHostname>,http://localhost:5173"
```

Also ensure auth vars match the SPA:

```text
AZURE_AD_TENANT_ID=<same tenant>
AZURE_AD_AUDIENCE=<API app client id GUID>
EDS_REQUIRE_AUTH=true
```

### 5. How the browser talks to the API

Default client code uses **relative** `/api/v1/...` when `VITE_AI_SERVICE_URL` is unset (works with Vite proxy locally).

On SWA (no linked Functions backend), set **`VITE_AI_SERVICE_URL`** to the ACA HTTPS FQDN so the browser calls the API directly. That requires:

- `CORS_ORIGINS` on ai-service includes the SWA origin
- Entra redirect URI includes the SWA origin

`staticwebapps.config.json` already:

- Rewrites unknown routes to `/index.html` (React Router)
- Excludes `/api/*` and static assets from the SPA fallback

### 6. Verify

```bash
SWA_HOST=$(az staticwebapp show -n "$SWA_NAME" -g "$RG" --query defaultHostname -o tsv)

# Site loads
curl -sI "https://$SWA_HOST" | head -n 5

# API reachable from the public internet (CORS checked in the browser)
curl -s "$AI_SERVICE_FQDN/api/v1/eds/health" | jq .
```

Open `https://$SWA_HOST` → sign in with Entra → scan a label.

### Troubleshooting

| Symptom | Check |
|--------|--------|
| Blank page / 404 on refresh | `staticwebapps.config.json` present in `dist`; `navigationFallback` rewrite |
| Login redirect loop / AADSTS50011 | SWA origin missing from Entra SPA redirect URIs |
| API `Failed to fetch` / CORS | Exact `https://…azurestaticapps.net` in ai-service `CORS_ORIGINS` |
| 401 from API | Token scope / `AZURE_AD_AUDIENCE` / `EDS_REQUIRE_AUTH` mismatch |
| API calls go to SWA host `/api/...` and 404 | Set `VITE_AI_SERVICE_URL` at **build** time and redeploy |
| Env vars “not applied” | `VITE_*` must exist during `npm run build`; changing SWA app settings alone does not rewrite an old bundle — **rebuild & redeploy** |

### Related

- AI service deploy: [`../ai-service/docs/AZURE_CONTAINER_APPS.md`](../ai-service/docs/AZURE_CONTAINER_APPS.md)
- Cosmos DB: [`../ai-service/docs/AZURE_COSMOS_DB.md`](../ai-service/docs/AZURE_COSMOS_DB.md)
- Apps overview: [`../README.md`](../README.md)
