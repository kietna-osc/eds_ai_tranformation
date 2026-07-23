/** EDS API client for ai-service `/api/v1/eds/*`. */

export type PackageInfo = {
  is_package_label: boolean;
  receiver_name: string;
  department: string;
  address: string;
  phone_number: string;
  clientInfo: string;
  clientNumber: string;
  clientItem: string;
  confidence?: number | null;
};

export type EmployeeMatch = {
  employee_id: string;
  name: string;
  department: string;
  email: string;
  planner_id: string;
  source: string;
  name_score: number;
  department_score: number;
  score: number;
};

export type Employee = {
  employee_id: string;
  name: string;
  department: string;
  email: string;
  planner_id: string;
  source: string;
};

export type ProcessResponse = {
  ok: boolean;
  error_code: string | null;
  message: string | null;
  package: PackageInfo;
  match: EmployeeMatch | null;
  candidates: EmployeeMatch[];
  confidence_tier: "high" | "low" | "reject";
  ocr_confidence: number | null;
  match_score: number | null;
  model_info?: string | null;
  ocr_latency_sec?: number | null;
  thresholds: { ocr_confidence: number; match_score: number };
};

export type NotifyResponse = {
  success: boolean;
  mode: string;
  planner_id: string;
  task_id: string | null;
  title: string | null;
  message: string;
};

export type UnknownPackage = {
  id: string;
  status: string;
  package: PackageInfo;
  note: string;
  image_base64?: string | null;
  created_at: string;
  assigned_employee_id?: string | null;
  assigned_name?: string | null;
  planner_task_id?: string | null;
};

const PROCESS_TIMEOUT_MS = 120_000;
const SHORT_TIMEOUT_MS = 15_000;

type TokenGetter = () => Promise<string | null>;
let accessTokenGetter: TokenGetter | null = null;

/** Wired by AuthProvider so every API call can attach the Entra access token. */
export function setAccessTokenGetter(getter: TokenGetter | null): void {
  accessTokenGetter = getter;
}

function apiBase(): string {
  const fromEnv = import.meta.env.VITE_AI_SERVICE_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  // Same-origin via Vite proxy (dev) or Azure SWA reverse proxy (prod).
  return "";
}

async function authHeaders(): Promise<Record<string, string>> {
  if (!accessTokenGetter) return {};
  try {
    const token = await accessTokenGetter();
    if (!token) return {};
    return { Authorization: `Bearer ${token}` };
  } catch (e) {
    console.warn("Failed to acquire Entra access token", e);
    return {};
  }
}

async function fetchJson<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs = SHORT_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const bearer = await authHeaders();
    const headers = new Headers(init.headers);
    for (const [k, v] of Object.entries(bearer)) {
      headers.set(k, v);
    }
    const res = await fetch(`${apiBase()}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
    });
    const text = await res.text();
    let data: T & { detail?: string };
    try {
      data = JSON.parse(text) as T & { detail?: string };
    } catch {
      throw new Error(`Bad response (${res.status}): ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      if (res.status === 401) {
        throw new Error("Unauthorized — sign in with Microsoft and try again.");
      }
      const detail = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
      throw new Error(detail || `Request failed (${res.status})`);
    }
    return data;
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    const msg = e instanceof Error ? e.message : String(e);
    if (name === "AbortError") {
      throw new Error(`Request timed out talking to AI service (${path}).`);
    }
    throw e instanceof Error ? e : new Error(msg);
  } finally {
    clearTimeout(timer);
  }
}

/** Convert image File → raw base64 (no data-URI prefix), optionally downscaled. */
export async function fileToBase64(file: File, maxSide = 1600): Promise<string> {
  if (!file || file.size <= 0) {
    throw new Error("Empty image file.");
  }
  const prepared = await downscaleToJpegBlob(file, maxSide);
  return blobToBase64(prepared);
}

async function downscaleToJpegBlob(file: File, maxSide: number): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return file;
    }
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    // q≥0.92: q=0.88 alone can drop GPT self-confidence below the EDS reject gate.
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", 0.95),
    );
    return blob ?? file;
  } catch {
    // HEIC / unsupported decode → send original bytes
    return file;
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  // Chunked btoa — avoids call-stack limits on large images
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  const b64 = btoa(binary);
  if (!b64) throw new Error("Could not encode image as base64.");
  return b64;
}

export async function processPackage(imageBase64: string): Promise<ProcessResponse> {
  return fetchJson<ProcessResponse>(
    "/api/v1/eds/process",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_base64: imageBase64, top_k: 8, ocr_engine: "gpt" }),
    },
    PROCESS_TIMEOUT_MS,
  );
}

export async function notifyPlanner(payload: {
  planner_id: string;
  department: string;
  assigned_name: string;
  employee_id?: string;
  package: PackageInfo;
}): Promise<NotifyResponse> {
  return fetchJson<NotifyResponse>(
    "/api/v1/eds/notify",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    PROCESS_TIMEOUT_MS,
  );
}

export async function listUnknown(
  status?: string | null,
  q?: string,
): Promise<UnknownPackage[]> {
  const params = new URLSearchParams();
  if (status && status.trim()) params.set("status", status.trim());
  if (q?.trim()) params.set("q", q.trim());
  const qs = params.toString();
  return fetchJson(`/api/v1/eds/unknown${qs ? `?${qs}` : ""}`);
}

export async function getUnknown(id: string): Promise<UnknownPackage> {
  return fetchJson(`/api/v1/eds/unknown/${id}`);
}

export async function createUnknown(payload: {
  image_base64?: string;
  package: PackageInfo;
  note?: string;
}): Promise<UnknownPackage> {
  return fetchJson(
    "/api/v1/eds/unknown",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    SHORT_TIMEOUT_MS,
  );
}

export async function assignUnknown(
  id: string,
  employeeId: string,
): Promise<{ unknown: UnknownPackage; notify: NotifyResponse | null }> {
  return fetchJson(
    `/api/v1/eds/unknown/${id}/assign`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employee_id: employeeId, notify: true }),
    },
    PROCESS_TIMEOUT_MS,
  );
}

export async function searchEmployees(q: string): Promise<Employee[]> {
  const params = new URLSearchParams({ limit: "40" });
  if (q.trim()) params.set("q", q.trim());
  return fetchJson(`/api/v1/eds/employees?${params}`);
}

export async function pingEds(): Promise<boolean> {
  try {
    await fetchJson("/api/v1/eds/health", {}, 5000);
    return true;
  } catch {
    return false;
  }
}
