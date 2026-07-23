import { Link } from "react-router-dom";

export function HomePage() {
  return (
    <section>
      <p className="eyebrow">Exeo Digital Solutions</p>
      <h1 className="brand-mark">EDS Reception</h1>
      <p className="lead">
        Mobile web app for package intake: OCR name + department from the label, fuzzy-match the
        roster, and notify the department Planner.
      </p>

      <div className="panel" style={{ marginTop: 18 }}>
        <h2 style={{ margin: "0 0 8px", fontFamily: "var(--display)", fontSize: "1.2rem" }}>
          Today&apos;s flow
        </h2>
        <ol style={{ margin: 0, paddingLeft: 18, color: "var(--ink-soft)", lineHeight: 1.55 }}>
          <li>Capture or upload a shipping label</li>
          <li>AI extracts recipient name + department</li>
          <li>Fuzzy-match the roster (name weighted higher) — always reviewable via search</li>
          <li>Notify the department Planner, or save to the unknown list</li>
        </ol>
        <div className="actions" style={{ marginTop: 16 }}>
          <Link className="btn btn-primary" to="/scan" style={{ textAlign: "center" }}>
            Start scanning
          </Link>
          <Link className="btn btn-secondary" to="/unknown" style={{ textAlign: "center" }}>
            Review unknown items
          </Link>
        </div>
      </div>
    </section>
  );
}
