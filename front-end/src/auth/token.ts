import {
  InteractionRequiredAuthError,
  type AccountInfo,
  type IPublicClientApplication,
} from "@azure/msal-browser";
import { apiScope, loginRequest } from "./msalConfig";

/** Acquire an Entra access token for ai-service (silent, then interactive if needed). */
export async function acquireApiToken(
  instance: IPublicClientApplication,
  account: AccountInfo | null,
): Promise<string | null> {
  if (!account) return null;
  const scopes = loginRequest().scopes;
  try {
    const result = await instance.acquireTokenSilent({
      account,
      scopes,
    });
    return result.accessToken;
  } catch (e) {
    if (e instanceof InteractionRequiredAuthError) {
      await instance.acquireTokenRedirect({ account, scopes });
      return null;
    }
    // Scope misconfigured — try openid profile as last resort for debugging.
    if (apiScope()) {
      try {
        const fallback = await instance.acquireTokenSilent({
          account,
          scopes: ["openid", "profile", "email"],
        });
        return fallback.accessToken;
      } catch {
        throw e instanceof Error ? e : new Error(String(e));
      }
    }
    throw e instanceof Error ? e : new Error(String(e));
  }
}
