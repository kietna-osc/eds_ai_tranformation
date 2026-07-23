import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { listUnknown, type UnknownPackage } from "../api";

type StatusFilter = "all" | "new" | "assigned";

export function UnknownListPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<UnknownPackage[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        // Fetch both statuses when "all" so older backends (default status=new) still work.
        const rows =
          statusFilter === "all"
            ? mergeUnknownById(
                await listUnknown("new"),
                await listUnknown("assigned"),
              )
            : await listUnknown(statusFilter);
        if (!cancelled) setItems(rows);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [statusFilter]);

  const titleCount = useMemo(() => items.length, [items]);

  return (
    <section>
      <h1 className="unknown-title">
        Unknown packages{loading ? "" : ` (${titleCount})`}
      </h1>

      <div className="filter-pills" role="tablist" aria-label="Status filter">
        {(
          [
            { id: "all", label: "All" },
            { id: "new", label: "Pending" },
            { id: "assigned", label: "Processed" },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={statusFilter === tab.id}
            className={`filter-pill${statusFilter === tab.id ? " active" : ""}`}
            onClick={() => setStatusFilter(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {error ? <div className="toast error">{error}</div> : null}
      {loading ? <p className="lead">Loading…</p> : null}

      {!loading && items.length === 0 ? (
        <div className="panel" style={{ marginTop: 14 }}>
          <p className="lead" style={{ margin: 0 }}>
            No unknown packages right now.
          </p>
          <Link className="btn btn-secondary" to="/scan" style={{ display: "inline-block", marginTop: 12 }}>
            Go to scan
          </Link>
        </div>
      ) : null}

      {!loading && items.length > 0 ? (
        <div className="unknown-card-list">
          {items.map((item) => {
            const pending = item.status !== "assigned";
            const name = item.package.receiver_name || item.assigned_name || "Unknown";
            const dept = item.package.department || "No department";
            return (
              <button
                key={item.id}
                type="button"
                className="unknown-row"
                onClick={() => navigate(`/unknown/${item.id}`)}
              >
                <span className="unknown-row-icon" aria-hidden>
                  <svg viewBox="0 0 24 24">
                    <path d="M12 3.5 21 20H3L12 3.5Z" />
                    <path d="M12 10v4.5M12 17.2h.01" />
                  </svg>
                </span>
                <span className="unknown-row-body">
                  <span className="unknown-row-top">
                    <span className="unknown-row-title">
                      {name} {dept}
                    </span>
                    <span className={`badge ${pending ? "badge-danger" : "badge-info"}`}>
                      {pending ? "Pending" : "Processed"}
                    </span>
                  </span>
                  <span className="unknown-row-time">{formatRelativeEn(item.created_at)}</span>
                </span>
                <span className="unknown-row-chevron" aria-hidden>
                  ›
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      <p className="unknown-footnote">
        Packages in the unknown list can only be viewed and processed by administrators.
      </p>
    </section>
  );
}

function mergeUnknownById(...lists: UnknownPackage[][]): UnknownPackage[] {
  const map = new Map<string, UnknownPackage>();
  for (const list of lists) {
    for (const row of list) map.set(row.id, row);
  }
  return [...map.values()].sort((a, b) => {
    const ta = Date.parse(a.created_at) || 0;
    const tb = Date.parse(b.created_at) || 0;
    return tb - ta;
  });
}

function formatRelativeEn(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const now = new Date();
    const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startThat = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const dayDiff = Math.round((startToday.getTime() - startThat.getTime()) / 86_400_000);
    if (dayDiff === 0) return `Today ${time}`;
    if (dayDiff === 1) return `Yesterday ${time}`;
    return d.toLocaleString("en-GB", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return iso;
  }
}
