import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { entraConfigured } from "../auth/msalConfig";

export function LoginPage() {
  const { account, login, configured } = useAuth();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from || "/";

  if (!entraConfigured() || !configured) {
    return <Navigate to="/" replace />;
  }
  if (account) {
    return <Navigate to={from} replace />;
  }

  return (
    <div className="app-shell app-shell-auth">
      <main className="app-main">
        <section className="login-section">
          <p className="eyebrow">Reception</p>
          <h1 className="brand-mark">EDS</h1>
          <p className="lead">
            Sign in with your Microsoft work account to process shipping labels.
          </p>
          <div className="panel" style={{ marginTop: 18 }}>
            <button
              className="btn btn-primary"
              type="button"
              style={{ width: "100%" }}
              onClick={() => void login()}
            >
              Sign in with Microsoft
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}
