/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AI_SERVICE_URL?: string;
  /** Entra ID (Azure AD) SPA application (client) ID */
  readonly VITE_AZURE_AD_CLIENT_ID?: string;
  /** Entra ID tenant ID (or "common" / "organizations") */
  readonly VITE_AZURE_AD_TENANT_ID?: string;
  /**
   * API scope requested for the access token sent to ai-service.
   * Default: api://{VITE_AZURE_AD_CLIENT_ID}/access_as_user
   */
  readonly VITE_AZURE_AD_API_SCOPE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
