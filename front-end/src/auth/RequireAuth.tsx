import { Navigate, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "./AuthContext";
import { entraConfigured } from "./msalConfig";

/** Gate app routes behind Microsoft Entra sign-in when configured. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { account, configured } = useAuth();
  const location = useLocation();

  if (!entraConfigured() || !configured) {
    return children;
  }
  if (!account) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return children;
}
