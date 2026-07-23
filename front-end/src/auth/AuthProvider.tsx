import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  MsalProvider,
  useMsal,
  useIsAuthenticated,
  useAccount,
} from "@azure/msal-react";
import type { AccountInfo } from "@azure/msal-browser";
import { setAccessTokenGetter } from "../api";
import { AuthContext, type AuthContextValue } from "./AuthContext";
import { entraConfigured, getMsalInstance, loginRequest } from "./msalConfig";
import { acquireApiToken } from "./token";

function AuthBridge({ children }: { children: ReactNode }) {
  const { instance, accounts } = useMsal();
  const isAuthenticated = useIsAuthenticated();
  const account = useAccount(accounts[0] ?? null);
  const configured = entraConfigured();

  const activeAccount: AccountInfo | null = useMemo(() => {
    if (!configured) return null;
    const current = instance.getActiveAccount();
    if (current) return current;
    if (account) {
      instance.setActiveAccount(account);
      return account;
    }
    if (accounts[0]) {
      instance.setActiveAccount(accounts[0]);
      return accounts[0];
    }
    return null;
  }, [configured, instance, account, accounts, isAuthenticated]);

  const getAccessToken = useCallback(async () => {
    if (!configured) return null;
    return acquireApiToken(instance, activeAccount);
  }, [configured, instance, activeAccount]);

  useEffect(() => {
    setAccessTokenGetter(getAccessToken);
    return () => setAccessTokenGetter(null);
  }, [getAccessToken]);

  const login = useCallback(async () => {
    await instance.loginRedirect(loginRequest());
  }, [instance]);

  const logout = useCallback(async () => {
    await instance.logoutRedirect({
      account: activeAccount ?? undefined,
      postLogoutRedirectUri: window.location.origin,
    });
  }, [instance, activeAccount]);

  const value: AuthContextValue = {
    configured,
    account: activeAccount,
    displayName: activeAccount?.name ?? null,
    email: activeAccount?.username ?? null,
    login,
    logout,
    getAccessToken,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function PassthroughAuth({ children }: { children: ReactNode }) {
  useEffect(() => {
    setAccessTokenGetter(async () => null);
    return () => setAccessTokenGetter(null);
  }, []);

  const value: AuthContextValue = {
    configured: false,
    account: null,
    displayName: null,
    email: null,
    login: async () => {
      throw new Error("Microsoft Entra ID is not configured (set VITE_AZURE_AD_*).");
    },
    logout: async () => undefined,
    getAccessToken: async () => null,
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(!entraConfigured());

  useEffect(() => {
    if (!entraConfigured()) {
      setReady(true);
      return;
    }
    let cancelled = false;
    (async () => {
      const instance = getMsalInstance();
      await instance.initialize();
      await instance.handleRedirectPromise();
      if (!cancelled) setReady(true);
    })().catch((e) => {
      console.error("MSAL init failed", e);
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) {
    return (
      <div className="app-shell app-shell-auth">
        <main className="app-main">
          <p className="lead">Starting sign-in…</p>
        </main>
      </div>
    );
  }

  if (!entraConfigured()) {
    return <PassthroughAuth>{children}</PassthroughAuth>;
  }

  return (
    <MsalProvider instance={getMsalInstance()}>
      <AuthBridge>{children}</AuthBridge>
    </MsalProvider>
  );
}
