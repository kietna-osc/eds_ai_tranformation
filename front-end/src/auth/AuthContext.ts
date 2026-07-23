import { createContext, useContext } from "react";
import type { AccountInfo } from "@azure/msal-browser";

export type AuthContextValue = {
  configured: boolean;
  account: AccountInfo | null;
  displayName: string | null;
  email: string | null;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  getAccessToken: () => Promise<string | null>;
};

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
