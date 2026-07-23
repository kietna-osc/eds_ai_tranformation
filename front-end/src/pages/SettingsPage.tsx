import { useEffect, useState } from "react";
import { pingEds } from "../api";
import { useAuth } from "../auth/AuthContext";
import { entraConfigured } from "../auth/msalConfig";

export function SettingsPage() {
  const [online, setOnline] = useState<boolean | null>(null);
  const { account, displayName, email, login, logout, configured } = useAuth();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ok = await pingEds();
      if (!cancelled) setOnline(ok);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section>
      <p className="eyebrow">Settings</p>
      <h1 className="brand-mark">EDS</h1>
      <div className="panel" style={{ marginTop: 16 }}>
        <div className="field" style={{ marginTop: 0 }}>
          <label>Microsoft account</label>
          {!entraConfigured() || !configured ? (
            <div style={{ fontWeight: 650 }}>Not configured (set VITE_AZURE_AD_*)</div>
          ) : account ? (
            <>
              <div style={{ fontWeight: 650 }}>{displayName || email || "Signed in"}</div>
              {email && displayName ? (
                <div style={{ color: "var(--muted)", fontSize: "0.86rem", marginTop: 4 }}>{email}</div>
              ) : null}
              <button
                className="btn btn-secondary"
                type="button"
                style={{ marginTop: 12 }}
                onClick={() => void logout()}
              >
                Sign out
              </button>
            </>
          ) : (
            <>
              <div style={{ fontWeight: 650 }}>Signed out</div>
              <button
                className="btn btn-primary"
                type="button"
                style={{ marginTop: 12 }}
                onClick={() => void login()}
              >
                Sign in with Microsoft
              </button>
            </>
          )}
        </div>
        <div className="field">
          <label>AI service</label>
          <div style={{ fontWeight: 650 }}>
            {online == null ? "Checking…" : online ? "Connected" : "Unreachable"}
          </div>
        </div>
        <div className="field">
          <label>Hosting</label>
          <div>Azure Static Web Apps (mobile web)</div>
        </div>
        <div className="field">
          <label>Notify target</label>
          <div>Microsoft Planner by department planner_id</div>
        </div>
        <div className="field">
          <label>Employee source</label>
          <div>Azure Cosmos DB `employees` (Mongo API)</div>
        </div>
      </div>
    </section>
  );
}
