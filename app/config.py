"""Settings, loaded from environment / .env."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=REPO_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- server -------------------------------------------------------
    host: str = "0.0.0.0"
    port: int = 8000
    log_level: str = "INFO"

    # --- caller authentication (Entra ID) -----------------------------
    # Who may upload. Unrelated to how this service authenticates to Graph.
    auth_enabled: bool = True
    # Defaults to azure_tenant_id; set only if the API lives in another tenant.
    auth_tenant_id: str = ""
    # This API's application ID URI or client id. Comma-separated to accept
    # both the v1.0 (api://<guid>) and v2.0 (<guid>) audience forms.
    auth_audience: str = ""
    # Optional scope gate, e.g. "access_as_user". Comma-separated; all required.
    auth_required_scope: str = ""
    # Reject app-only (client-credentials) tokens: uploads must come from a person.
    auth_require_delegated: bool = True
    auth_jwks_ttl_sec: int = 3600

    # --- extraction ---------------------------------------------------
    # "vlm"      : image -> vision model -> fields
    # "ocr_llm"  : image -> Azure Document Intelligence -> LLM -> fields
    extractor: str = "vlm"

    llm_base_url: str = "https://openrouter.ai/api/v1"
    llm_api_key: str = ""
    llm_model: str = "openai/gpt-5.2"
    llm_temperature: float = 0.0
    llm_max_tokens: int = 2048
    llm_timeout_sec: float = 90.0
    # Azure OpenAI needs an api-version query param; leave empty elsewhere.
    llm_api_version: str = ""

    azure_di_endpoint: str = ""
    azure_di_key: str = ""
    azure_di_model_id: str = "prebuilt-read"

    # --- routing ------------------------------------------------------
    directory_path: Path = REPO_ROOT / "config" / "directory.yaml"
    # Below this fuzzy score (0-100) the department is treated as unresolved.
    min_department_score: float = 70.0
    # Below this the extraction is treated as unresolved (task still created,
    # in the fallback bucket, so nothing is silently dropped).
    min_confidence: float = 0.35
    min_employee_score: float = 70.0

    # --- graph / planner ----------------------------------------------
    # Read by DefaultAzureCredential too; used here only to build task links.
    azure_tenant_id: str = ""
    graph_base_url: str = "https://graph.microsoft.com/v1.0"
    graph_scope: str = "https://graph.microsoft.com/.default"
    graph_timeout_sec: float = 60.0
    plan_id: str = ""
    # Folder inside the group's document library where images are stored.
    upload_folder: str = "DonHang"
    task_title_template: str = "{receiver_name} - don hang moi"
    unknown_receiver_label: str = "Khong ro nguoi nhan"

    max_upload_bytes: int = 15 * 1024 * 1024


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
