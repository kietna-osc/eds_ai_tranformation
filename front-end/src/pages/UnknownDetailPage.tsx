import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  assignUnknown,
  getUnknown,
  searchEmployees,
  type Employee,
  type UnknownPackage,
} from "../api";

export function UnknownDetailPage() {
  const { id = "" } = useParams();
  const [item, setItem] = useState<UnknownPackage | null>(null);
  const [q, setQ] = useState("");
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [searchTouched, setSearchTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const row = await getUnknown(id);
        if (!cancelled) {
          setItem(row);
          setQ(row.package.receiver_name || row.package.department || "");
          setEmployees([]);
          setSearchTouched(false);
          setSelectedId(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function runEmployeeSearch(query = q) {
    setSearchTouched(true);
    setSearching(true);
    setError(null);
    try {
      const rows = await searchEmployees(query.trim());
      setEmployees(rows);
    } catch (e) {
      setEmployees([]);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
    }
  }

  async function onAssign() {
    if (!selectedId) return;
    setSaving(true);
    setError(null);
    try {
      const res = await assignUnknown(id, selectedId);
      setItem(res.unknown);
      setToast(res.notify?.message || "Assigned and notified Planner.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <section>
        <p className="eyebrow">Admin</p>
        <h1 className="brand-mark">Unknown item</h1>
        <p className="lead">Loading…</p>
      </section>
    );
  }

  if (!item) {
    return (
      <section>
        <p className="eyebrow">Admin</p>
        <h1 className="brand-mark">Unknown item</h1>
        <div className="toast error">{error || "Not found"}</div>
        <Link className="btn btn-secondary" to="/unknown" style={{ display: "inline-block", marginTop: 12 }}>
          Back to list
        </Link>
      </section>
    );
  }

  const imgSrc = item.image_base64
    ? `data:image/jpeg;base64,${item.image_base64}`
    : null;

  return (
    <section>
      <p className="eyebrow">Admin</p>
      <h1 className="brand-mark">Assign recipient</h1>
      <p className="lead">Search the roster, confirm the person, then send to their department Planner.</p>

      <div className="panel" style={{ marginTop: 14, padding: 0, overflow: "hidden" }}>
        {imgSrc ? (
          <img
            src={imgSrc}
            alt="Unknown package"
            style={{ width: "100%", display: "block", maxHeight: 280, objectFit: "cover" }}
          />
        ) : (
          <div style={{ height: 160, background: "#dfe8e7" }} />
        )}
        <div style={{ padding: 16 }}>
          <div className="field" style={{ marginTop: 0 }}>
            <label>OCR name</label>
            <div style={{ fontWeight: 650 }}>{item.package.receiver_name || "—"}</div>
          </div>
          <div className="field">
            <label>OCR department</label>
            <div style={{ fontWeight: 650 }}>{item.package.department || "—"}</div>
          </div>
          <span className={`badge ${item.status === "assigned" ? "badge-ok" : "badge-warn"}`}>
            {item.status === "assigned" ? "Processed" : "Pending"}
          </span>
        </div>
      </div>

      {item.status !== "assigned" ? (
        <>
          <div className="search-panel" style={{ marginTop: 16 }}>
            <label className="field-label">Search for recipient</label>
            <form
              className="search-bar"
              onSubmit={(e) => {
                e.preventDefault();
                void runEmployeeSearch();
              }}
            >
              <input
                value={q}
                placeholder="Name or department"
                aria-label="Search by name or department"
                onChange={(e) => setQ(e.target.value)}
              />
              <button
                type="submit"
                className="search-icon-btn"
                aria-label="Search"
                disabled={searching}
              >
                {searching ? (
                  <span className="spinner search-spinner" />
                ) : (
                  <svg viewBox="0 0 24 24" aria-hidden>
                    <circle cx="11" cy="11" r="6.5" />
                    <path d="M16.5 16.5 21 21" />
                  </svg>
                )}
              </button>
            </form>

            <div className="list candidate-list candidate-list-scroll">
              {!searchTouched ? (
                <p className="lead" style={{ margin: 0, fontSize: "0.9rem" }}>
                  Enter a name or department, then tap search.
                </p>
              ) : searching ? (
                <p className="lead" style={{ margin: 0, fontSize: "0.9rem" }}>
                  Searching…
                </p>
              ) : employees.length === 0 ? (
                <p className="lead" style={{ margin: 0, fontSize: "0.9rem" }}>
                  No employees found.
                </p>
              ) : (
                employees.map((emp) => (
                  <button
                    key={emp.employee_id}
                    type="button"
                    className={`candidate${selectedId === emp.employee_id ? " selected" : ""}`}
                    onClick={() => setSelectedId(emp.employee_id)}
                  >
                    <strong>{emp.name || "(no name)"}</strong>
                    <span>
                      {emp.department || "No department"}
                      {emp.planner_id ? ` · planner ${emp.planner_id.slice(0, 14)}…` : ""}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>

          <div className="actions">
            <button
              className="btn btn-accent"
              type="button"
              disabled={!selectedId || saving}
              onClick={onAssign}
            >
              {saving ? <span className="spinner" /> : "Confirm & Assign"}
            </button>
            <Link className="btn btn-ghost" to="/unknown" style={{ textAlign: "center" }}>
              Back to list
            </Link>
          </div>
        </>
      ) : (
        <div className="actions">
          <div className="toast">Assigned to {item.assigned_name || "recipient"}.</div>
          <Link className="btn btn-primary" to="/unknown" style={{ textAlign: "center" }}>
            Back to list
          </Link>
        </div>
      )}

      {error ? <div className="toast error">{error}</div> : null}
      {toast ? <div className="toast">{toast}</div> : null}
    </section>
  );
}
