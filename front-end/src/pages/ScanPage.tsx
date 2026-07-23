import { useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  createUnknown,
  fileToBase64,
  notifyPlanner,
  processPackage,
  searchEmployees,
  type Employee,
  type EmployeeMatch,
  type PackageInfo,
  type ProcessResponse,
} from "../api";

type Stage = "idle" | "processing" | "result" | "notifying" | "done" | "error";
type ResultTab = "suggested" | "search";

type SelectedRecipient = {
  employee_id: string;
  name: string;
  department: string;
  email: string;
  planner_id: string;
  source: string;
  score?: number;
};

function fromMatch(m: EmployeeMatch): SelectedRecipient {
  return {
    employee_id: m.employee_id,
    name: m.name,
    department: m.department,
    email: m.email,
    planner_id: m.planner_id,
    source: m.source,
    score: m.score,
  };
}

function fromEmployee(e: Employee): SelectedRecipient {
  return {
    employee_id: e.employee_id,
    name: e.name,
    department: e.department,
    email: e.email,
    planner_id: e.planner_id,
    source: e.source,
  };
}

function formatOcrScore(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "—";
  return `${Math.round(value * 100)}%`;
}

export function ScanPage() {
  const navigate = useNavigate();
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [result, setResult] = useState<ProcessResponse | null>(null);
  const [selected, setSelected] = useState<SelectedRecipient | null>(null);
  const [nameEdit, setNameEdit] = useState("");
  const [deptEdit, setDeptEdit] = useState("");
  const [resultTab, setResultTab] = useState<ResultTab>("suggested");
  const [searchQ, setSearchQ] = useState("");
  const [searchHits, setSearchHits] = useState<Employee[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchTouched, setSearchTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const packageView = useMemo(() => {
    if (!result) return null;
    return {
      ...result.package,
      receiver_name: nameEdit || result.package.receiver_name,
      department: deptEdit || result.package.department,
    } satisfies PackageInfo;
  }, [result, nameEdit, deptEdit]);

  const ocrThreshold = result?.thresholds.ocr_confidence ?? 0.65;
  const matchThreshold = result?.thresholds.match_score ?? 80;
  const lowOcr =
    result?.ocr_confidence != null && result.ocr_confidence < ocrThreshold;
  const lowMatch =
    result?.match_score != null && result.match_score < matchThreshold;
  const showScoreNotice = Boolean(
    lowOcr || lowMatch || result?.error_code === "not_package_label",
  );

  const topCandidates = useMemo(
    () => (result?.candidates ?? []).slice(0, 3),
    [result],
  );

  async function runEmployeeSearch(query = searchQ) {
    setSearchTouched(true);
    setSearching(true);
    setError(null);
    try {
      const rows = await searchEmployees(query.trim());
      setSearchHits(rows);
    } catch (e) {
      setSearchHits([]);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
    }
  }

  async function onPick(file: File | undefined) {
    if (!file) return;
    setError(null);
    setToast(null);
    setResult(null);
    setSelected(null);
    setResultTab("suggested");
    setSearchQ("");
    setSearchHits([]);
    setSearchTouched(false);
    setStage("idle");
    setImageBase64(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(file));
    try {
      const b64 = await fileToBase64(file);
      setImageBase64(b64);
    } catch (e) {
      setImageBase64(null);
      setError(e instanceof Error ? e.message : "Failed to read image file.");
    } finally {
      if (cameraRef.current) cameraRef.current.value = "";
      if (galleryRef.current) galleryRef.current.value = "";
    }
  }

  async function onProcess() {
    if (!imageBase64) {
      setError("Image is still loading. Wait a moment, or re-upload the photo.");
      return;
    }
    setStage("processing");
    setError(null);
    setToast(null);
    try {
      const res = await processPackage(imageBase64);
      setResult(res);
      setNameEdit(res.package.receiver_name || "");
      setDeptEdit(res.package.department || "");
      setSelected(res.match ? fromMatch(res.match) : null);
      setResultTab("suggested");
      setSearchQ(res.package.receiver_name || "");
      setSearchHits([]);
      setSearchTouched(false);
      // Low OCR / low fuzzy never block — only transport/service failures use error stage.
      setStage("result");
    } catch (e) {
      setStage("error");
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onConfirmSend() {
    if (!packageView || !selected?.planner_id) {
      setError("Select a recipient with a department planner id.");
      return;
    }
    setStage("notifying");
    setError(null);
    try {
      const notify = await notifyPlanner({
        planner_id: selected.planner_id,
        department: selected.department || packageView.department,
        assigned_name: selected.name || packageView.receiver_name,
        employee_id: selected.employee_id,
        package: packageView,
      });
      setStage("done");
      setToast(notify.message || "Sent to department Planner.");
    } catch (e) {
      setStage("result");
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onStoreUnknown() {
    if (!packageView) return;
    try {
      const created = await createUnknown({
        image_base64: imageBase64 || undefined,
        package: packageView,
        note: "Stored from scan result",
      });
      setToast("Saved to unknown list.");
      navigate(`/unknown/${created.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function reset() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setImageBase64(null);
    setStage("idle");
    setResult(null);
    setSelected(null);
    setNameEdit("");
    setDeptEdit("");
    setResultTab("suggested");
    setSearchQ("");
    setSearchHits([]);
    setSearchTouched(false);
    setError(null);
    setToast(null);
  }

  if (stage === "error") {
    return (
      <section>
        <p className="eyebrow">Reception</p>
        <h1 className="brand-mark">EDS</h1>
        <div className="panel status-card" style={{ marginTop: 18 }}>
          <div className="status-icon error">!</div>
          <h2 style={{ margin: "0 0 8px", fontFamily: "var(--display)" }}>Service error</h2>
          <p className="lead">{error || "AI service failed. Please try again."}</p>
          <div className="actions" style={{ marginTop: 20 }}>
            <button className="btn btn-primary" type="button" onClick={reset}>
              Retry
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (stage === "done") {
    return (
      <section>
        <p className="eyebrow">Reception</p>
        <h1 className="brand-mark">EDS</h1>
        <div className="panel status-card" style={{ marginTop: 18 }}>
          <div className="status-icon success">✓</div>
          <h2 style={{ margin: "0 0 8px", fontFamily: "var(--display)" }}>Sent to Planner</h2>
          <p className="lead">{toast || "Department notification created."}</p>
          <div className="actions" style={{ marginTop: 20 }}>
            <button className="btn btn-primary" type="button" onClick={reset}>
              Scan next package
            </button>
          </div>
        </div>
      </section>
    );
  }

  if ((stage === "result" || stage === "notifying") && result && packageView) {
    return (
      <section>
        <p className="eyebrow">OCR result</p>
        <h1 className="brand-mark">EDS</h1>
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="thumb-row">
            {previewUrl ? <img className="thumb" src={previewUrl} alt="Captured label" /> : <div className="thumb" />}
            <div>
              <span className={`badge ${showScoreNotice ? "badge-warn" : "badge-ok"}`}>
                {showScoreNotice ? "Review suggested" : "Ready to notify"}
              </span>
              <p className="lead" style={{ marginTop: 8 }}>
                Confirm the match or search by name + department, then notify Planner.
              </p>
            </div>
          </div>

          {showScoreNotice ? (
            <div className="score-notice" role="status">
              {result.error_code === "not_package_label"
                ? "This image may not be a shipping label. "
                : null}
              {lowOcr
                ? `OCR score ${formatOcrScore(result.ocr_confidence)} (threshold ${formatOcrScore(ocrThreshold)}). `
                : result.ocr_confidence != null
                  ? `OCR score ${formatOcrScore(result.ocr_confidence)}. `
                  : null}
              {result.match_score != null
                ? `Match score ${Math.round(result.match_score)} (threshold ${Math.round(matchThreshold)}).`
                : "No strong roster match yet — use search below."}
            </div>
          ) : null}

          <div className="field">
            <label>Recipient name (OCR)</label>
            <input value={nameEdit} onChange={(e) => setNameEdit(e.target.value)} />
          </div>
          <div className="field">
            <label>Department (OCR)</label>
            <input value={deptEdit} onChange={(e) => setDeptEdit(e.target.value)} />
          </div>

          <div className="tab-strip" role="tablist" aria-label="Recipient selection">
            <button
              type="button"
              role="tab"
              aria-selected={resultTab === "suggested"}
              className={`tab-strip-btn${resultTab === "suggested" ? " active" : ""}`}
              onClick={() => setResultTab("suggested")}
            >
              Suggested
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={resultTab === "search"}
              className={`tab-strip-btn${resultTab === "search" ? " active" : ""}`}
              onClick={() => setResultTab("search")}
            >
              Search
            </button>
          </div>

          {resultTab === "suggested" ? (
            <div className="tab-panel" role="tabpanel">
              <div className="list candidate-list">
                {topCandidates.length === 0 ? (
                  <p className="lead" style={{ margin: 0, fontSize: "0.9rem" }}>
                    No suggested matches. Switch to Search to find a recipient.
                  </p>
                ) : (
                  topCandidates.map((c) => (
                    <button
                      key={c.employee_id}
                      type="button"
                      className={`candidate${selected?.employee_id === c.employee_id ? " selected" : ""}`}
                      onClick={() => {
                        setSelected(fromMatch(c));
                        setNameEdit(c.name);
                        setDeptEdit(c.department);
                      }}
                    >
                      <strong>
                        {c.name || "(no name)"} · {Math.round(c.score)}
                      </strong>
                      <span>
                        {c.department || "No department"}
                        {c.planner_id ? ` · planner ${c.planner_id.slice(0, 14)}…` : ""}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </div>
          ) : (
            <div className="tab-panel search-panel" role="tabpanel">
              <form
                className="search-bar"
                onSubmit={(e) => {
                  e.preventDefault();
                  void runEmployeeSearch();
                }}
              >
                <input
                  value={searchQ}
                  placeholder="Name or department"
                  aria-label="Search by name or department"
                  onChange={(e) => setSearchQ(e.target.value)}
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
                ) : searchHits.length === 0 ? (
                  <p className="lead" style={{ margin: 0, fontSize: "0.9rem" }}>
                    No employees found.
                  </p>
                ) : (
                  searchHits.map((emp) => (
                    <button
                      key={emp.employee_id}
                      type="button"
                      className={`candidate${selected?.employee_id === emp.employee_id ? " selected" : ""}`}
                      onClick={() => {
                        setSelected(fromEmployee(emp));
                        setNameEdit(emp.name);
                        setDeptEdit(emp.department);
                      }}
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
          )}

          {error ? <div className="toast error">{error}</div> : null}

          <div className="actions" style={{ marginTop: 18 }}>
            <button
              className="btn btn-accent"
              type="button"
              disabled={stage === "notifying" || !selected?.planner_id}
              onClick={onConfirmSend}
            >
              {stage === "notifying" ? <span className="spinner" /> : "Confirm & Send to Planner"}
            </button>
            <button className="btn btn-secondary" type="button" onClick={onStoreUnknown}>
              Add to unknown list
            </button>
            <button className="btn btn-ghost" type="button" onClick={reset}>
              Start over
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section>
      <p className="eyebrow">Reception</p>
      <h1 className="brand-mark">EDS</h1>
      <p className="lead">
        Capture or upload a shipping label. OCR extracts name + department, then fuzzy-matches the
        roster (name weighted higher).
      </p>

      <div className="capture-stage">
        {previewUrl ? (
          <img src={previewUrl} alt="Selected label preview" />
        ) : (
          <div className="capture-empty">
            <div className="capture-icon">
              <svg viewBox="0 0 24 24" aria-hidden>
                <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
                <circle cx="12" cy="12" r="3.5" />
              </svg>
            </div>
            Point the camera at the package label
          </div>
        )}
      </div>

      <input
        ref={cameraRef}
        className="hidden-input"
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(e) => onPick(e.target.files?.[0])}
      />
      <input
        ref={galleryRef}
        className="hidden-input"
        type="file"
        accept="image/*"
        onChange={(e) => onPick(e.target.files?.[0])}
      />

      <div className="actions row">
        <button className="btn btn-secondary" type="button" onClick={() => cameraRef.current?.click()}>
          Take Photo
        </button>
        <button className="btn btn-secondary" type="button" onClick={() => galleryRef.current?.click()}>
          Upload from Gallery
        </button>
      </div>

      <div className="actions">
        <button
          className="btn btn-primary"
          type="button"
          disabled={!imageBase64 || stage === "processing"}
          onClick={() => void onProcess()}
        >
          {stage === "processing" ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
              <span className="spinner" />
              Processing… (OCR may take up to 1 min)
            </span>
          ) : !imageBase64 && previewUrl ? (
            "Preparing image…"
          ) : (
            "Process label"
          )}
        </button>
        <Link className="btn btn-ghost" to="/unknown" style={{ textAlign: "center" }}>
          Open unknown list
        </Link>
      </div>

      {error ? <div className="toast error">{error}</div> : null}
      {toast ? <div className="toast">{toast}</div> : null}
    </section>
  );
}
