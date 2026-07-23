/** Microsoft Entra ID (Azure AD) MSAL configuration for the EDS SPA. */

import type { Configuration, RedirectRequest } from "@azure/msal-browser";
import { LogLevel, PublicClientApplication } from "@azure/msal-browser";

export function entraConfigured(): boolean {
  return Boolean(
    import.meta.env.VITE_AZURE_AD_CLIENT_ID?.trim() &&
      import.meta.env.VITE_AZURE_AD_TENANT_ID?.trim(),
  );
}

export function apiScope(): string {
  const explicit = import.meta.env.VITE_AZURE_AD_API_SCOPE?.trim();
  if (explicit) return explicit;
  const clientId = import.meta.env.VITE_AZURE_AD_CLIENT_ID?.trim();
  // Default: expose an API scope on the same app registration.
  return clientId ? `api://${clientId}/access_as_user` : "";
}

export function msalConfig(): Configuration {
  const clientId = import.meta.env.VITE_AZURE_AD_CLIENT_ID?.trim() || "";
  const tenantId = import.meta.env.VITE_AZURE_AD_TENANT_ID?.trim() || "";
  return {
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
      redirectUri: window.location.origin,
      postLogoutRedirectUri: window.location.origin,
    },
    cache: {
      cacheLocation: "localStorage",
    },
    system: {
      loggerOptions: {
        logLevel: LogLevel.Warning,
      },
    },
  };
}

/** Scopes for the access token sent to ai-service. */
export function loginRequest(): RedirectRequest {
  const scopes = [apiScope()].filter(Boolean);
  // Fallback so login still works before API scope is exposed in Entra.
  if (scopes.length === 0) {
    scopes.push("openid", "profile", "email");
  }
  return { scopes };
}

let pca: PublicClientApplication | null = null;

export function getMsalInstance(): PublicClientApplication {
  if (!pca) {
    pca = new PublicClientApplication(msalConfig());
  }
  return pca;
}
