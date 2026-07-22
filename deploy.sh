#!/usr/bin/env bash
#
# Deploy this service to Azure Container Apps.
#
#   ./deploy.sh
#
# Reads .env next to this script. Idempotent: first run creates everything,
# later runs rebuild the image and roll out a new revision.
#
# Extraction: vlm. Graph auth: client secret.

set -euo pipefail

# Git Bash rewrites arguments that look like paths ("api://..." , "/subscriptions/...").
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL="*"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

info() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33mWARN: %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------
[[ -f "$ENV_FILE" ]] || die "No .env at $ENV_FILE (copy .env.example and fill it in)"

# Load .env without executing it: only KEY=VALUE lines, comments and blanks skipped.
while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"                       # tolerate CRLF
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    value="${value%\"}"; value="${value#\"}"   # strip surrounding quotes
    value="${value%\'}"; value="${value#\'}"
    export "$key=$value"
done < "$ENV_FILE"

require() {
    local name="$1"
    [[ -n "${!name:-}" ]] || die "$name is not set in $ENV_FILE"
}

# Application settings that must come from .env
require AZURE_TENANT_ID
require AZURE_CLIENT_ID
require AZURE_CLIENT_SECRET
require PLAN_ID
require LLM_API_KEY

# Deployment settings, overridable in .env
RESOURCE_GROUP="${RESOURCE_GROUP:-rg-planner-app}"
LOCATION="${LOCATION:-southeastasia}"
ACR_NAME="${ACR_NAME:-}"
APP_NAME="${APP_NAME:-planner-app}"
IMAGE_TAG="${IMAGE_TAG:-v1}"
TARGET_PORT="${TARGET_PORT:-8000}"
INGRESS="${INGRESS:-external}"
MIN_REPLICAS="${MIN_REPLICAS:-1}"

# Application runtime settings
EXTRACTOR="vlm"
LLM_BASE_URL="${LLM_BASE_URL:-https://openrouter.ai/api/v1}"
LLM_MODEL="${LLM_MODEL:-openai/gpt-5.2}"
UPLOAD_FOLDER="${UPLOAD_FOLDER:-DonHang}"
AUTH_ENABLED="${AUTH_ENABLED:-true}"
AUTH_AUDIENCE="${AUTH_AUDIENCE:-}"
AUTH_REQUIRED_SCOPE="${AUTH_REQUIRED_SCOPE:-}"
LOG_LEVEL="${LOG_LEVEL:-INFO}"

[[ -n "$ACR_NAME" ]] || die "ACR_NAME is not set in $ENV_FILE (globally unique, lowercase letters and digits only)"
[[ "$ACR_NAME" =~ ^[a-z0-9]{5,50}$ ]] || die "ACR_NAME must be 5-50 lowercase alphanumeric characters: $ACR_NAME"

if [[ "$AUTH_ENABLED" == "true" && -z "$AUTH_AUDIENCE" ]]; then
    die "AUTH_ENABLED=true requires AUTH_AUDIENCE (the API app registration's ID URI).
     The container refuses to start without it. Set AUTH_ENABLED=false only for a
     throwaway test - it leaves the upload endpoint open to anyone."
fi

IMAGE="${ACR_NAME}.azurecr.io/${APP_NAME}:${IMAGE_TAG}"

# --------------------------------------------------------------------------
# Azure CLI
# --------------------------------------------------------------------------
AZ="${AZ:-az}"
if ! command -v "$AZ" >/dev/null 2>&1; then
    for candidate in az.cmd "/c/Program Files/Microsoft SDKs/Azure/CLI2/wbin/az.cmd"; do
        if command -v "$candidate" >/dev/null 2>&1; then AZ="$candidate"; break; fi
    done
fi
command -v "$AZ" >/dev/null 2>&1 || die "Azure CLI not found. Install it, or set AZ=/path/to/az"

info "Signing in"
if ! "$AZ" account show >/dev/null 2>&1; then
    "$AZ" login
fi
SUBSCRIPTION="$("$AZ" account show --query name -o tsv)"
echo "Subscription: $SUBSCRIPTION"
echo "Target      : $APP_NAME in $RESOURCE_GROUP ($LOCATION)"
echo "Image       : $IMAGE"

info "Ensuring the containerapp extension and resource providers are ready"
"$AZ" extension add --name containerapp --upgrade --only-show-errors >/dev/null
"$AZ" provider register -n Microsoft.App --wait --only-show-errors
"$AZ" provider register -n Microsoft.OperationalInsights --wait --only-show-errors

# --------------------------------------------------------------------------
# Registry and image
# --------------------------------------------------------------------------
info "Resource group"
"$AZ" group create -n "$RESOURCE_GROUP" -l "$LOCATION" --only-show-errors >/dev/null

info "Container registry"
if ! "$AZ" acr show -n "$ACR_NAME" -g "$RESOURCE_GROUP" --only-show-errors >/dev/null 2>&1; then
    "$AZ" acr create -n "$ACR_NAME" -g "$RESOURCE_GROUP" \
        --sku Basic --admin-enabled true --only-show-errors >/dev/null
else
    echo "already exists"
fi

info "Building $IMAGE (builds in Azure - no local Docker needed)"
"$AZ" acr build -r "$ACR_NAME" -t "${APP_NAME}:${IMAGE_TAG}" "$SCRIPT_DIR"

# --------------------------------------------------------------------------
# Container app
# --------------------------------------------------------------------------
APP_EXISTS=false
if "$AZ" containerapp show -n "$APP_NAME" -g "$RESOURCE_GROUP" --only-show-errors >/dev/null 2>&1; then
    APP_EXISTS=true
fi

if [[ "$APP_EXISTS" == false ]]; then
    info "Creating the container app"
    "$AZ" containerapp up \
        -n "$APP_NAME" \
        -g "$RESOURCE_GROUP" \
        -l "$LOCATION" \
        --image "$IMAGE" \
        --target-port "$TARGET_PORT" \
        --ingress "$INGRESS"
fi

# Secrets first: the env vars below reference them.
info "Storing secrets"
"$AZ" containerapp secret set -n "$APP_NAME" -g "$RESOURCE_GROUP" --only-show-errors \
    --secrets \
        azure-client-secret="$AZURE_CLIENT_SECRET" \
        llm-api-key="$LLM_API_KEY" \
    >/dev/null

info "Applying configuration and rolling out $IMAGE_TAG"
ENV_VARS=(
    "AZURE_TENANT_ID=$AZURE_TENANT_ID"
    "AZURE_CLIENT_ID=$AZURE_CLIENT_ID"
    "AZURE_CLIENT_SECRET=secretref:azure-client-secret"
    "PLAN_ID=$PLAN_ID"
    "UPLOAD_FOLDER=$UPLOAD_FOLDER"
    "EXTRACTOR=$EXTRACTOR"
    "LLM_BASE_URL=$LLM_BASE_URL"
    "LLM_MODEL=$LLM_MODEL"
    "LLM_API_KEY=secretref:llm-api-key"
    "AUTH_ENABLED=$AUTH_ENABLED"
    "LOG_LEVEL=$LOG_LEVEL"
)
[[ -n "$AUTH_AUDIENCE" ]] && ENV_VARS+=("AUTH_AUDIENCE=$AUTH_AUDIENCE")
[[ -n "$AUTH_REQUIRED_SCOPE" ]] && ENV_VARS+=("AUTH_REQUIRED_SCOPE=$AUTH_REQUIRED_SCOPE")

"$AZ" containerapp update -n "$APP_NAME" -g "$RESOURCE_GROUP" --only-show-errors \
    --image "$IMAGE" \
    --min-replicas "$MIN_REPLICAS" \
    --set-env-vars "${ENV_VARS[@]}" \
    >/dev/null

FQDN="$("$AZ" containerapp show -n "$APP_NAME" -g "$RESOURCE_GROUP" \
    --query properties.configuration.ingress.fqdn -o tsv)"
BASE="https://$FQDN"

# --------------------------------------------------------------------------
# Smoke test
# --------------------------------------------------------------------------
info "Waiting for the new revision to serve traffic"
for attempt in $(seq 1 30); do
    if curl -fsS --max-time 10 "$BASE/health" >/dev/null 2>&1; then
        echo "healthy after ${attempt} attempt(s)"
        break
    fi
    [[ $attempt -eq 30 ]] && warn "/health did not answer; check: $AZ containerapp logs show -n $APP_NAME -g $RESOURCE_GROUP --follow"
    sleep 5
done

info "Readiness (proves the Graph credential and PLAN_ID work)"
READY="$(curl -fsS --max-time 30 "$BASE/health/ready" || echo '{"status":"unreachable"}')"
echo "$READY"
case "$READY" in
    *'"status":"ok"'*) ;;
    *) warn "Not ready. Common causes: wrong AZURE_CLIENT_SECRET, missing Graph admin
      consent (Tasks.ReadWrite.All, Group.ReadWrite.All, Files.ReadWrite.All),
      or a PLAN_ID whose plan is not owned by an M365 group." ;;
esac

info "Deployed"
cat <<EOF
URL   : $BASE
Docs  : $BASE/docs
Logs  : $AZ containerapp logs show -n $APP_NAME -g $RESOURCE_GROUP --follow

Upload (needs a user token - /api/v1/* rejects unauthenticated calls):

  TOKEN=\$($AZ account get-access-token --resource ${AUTH_AUDIENCE:-api://<api-app-id>} --query accessToken -o tsv)
  curl -H "Authorization: Bearer \$TOKEN" $BASE/api/v1/me
  curl -H "Authorization: Bearer \$TOKEN" -X POST $BASE/api/v1/orders -F "image=@sample.jpg"

Redeploy after a code change: set IMAGE_TAG=v2 in .env and run this script again.
EOF
