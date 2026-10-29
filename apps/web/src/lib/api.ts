import { ApiError, createApiClient } from "@nova/shared";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000").replace(/\/+$/, "");

export const TOKEN_KEY = "nova.token";
export const USER_KEY = "nova.user";

let unauthorizedHandler: (() => void) | null = null;

/** AuthProvider registers its logout here so any 401 anywhere signs the user out. */
export function setUnauthorizedHandler(fn: (() => void) | null) {
  unauthorizedHandler = fn;
}

export function readToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** The one API client for the whole web app (see packages/shared/src/api-client.ts). */
export const api = createApiClient({
  baseUrl: API_URL,
  getToken: readToken,
  onUnauthorized: () => unauthorizedHandler?.(),
});

/** Human-readable message for any thrown value (ApiError, network failure, …). */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message || `Request failed (${err.status})`;
  if (err instanceof TypeError) return `Can't reach the Nova API at ${API_URL}. Is it running?`;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

/**
 * Pull per-field messages out of an API validation error. Accepts the common shapes:
 * zod `flatten()` ({ fieldErrors: { email: ["…"] } }), zod issues ([{ path: ["email"], message }]),
 * or a plain { field: "message" } map.
 */
export function fieldErrors(err: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!(err instanceof ApiError) || !err.details) return out;
  const d = err.details as unknown;
  const put = (k: unknown, v: unknown) => {
    const key = String(k);
    const msg = Array.isArray(v) ? v[0] : v;
    if (key && typeof msg === "string" && !out[key]) out[key] = msg;
  };
  if (Array.isArray(d)) {
    for (const issue of d) {
      if (issue && typeof issue === "object") {
        const i = issue as { path?: unknown; message?: unknown; field?: unknown };
        const p = Array.isArray(i.path) ? i.path[0] : (i.path ?? i.field);
        put(p, i.message);
      }
    }
  } else if (typeof d === "object" && d) {
    const obj = d as Record<string, unknown>;
    const fe = (obj.fieldErrors ?? obj.fields ?? obj) as Record<string, unknown>;
    if (fe && typeof fe === "object") for (const [k, v] of Object.entries(fe)) put(k, v);
    if (Array.isArray(obj.issues)) Object.assign(out, fieldErrors(new ApiError(0, "", "", obj.issues)));
  }
  return out;
}

/** Map a zod safeParse error to { field: firstMessage }. */
export function zodFieldErrors(error: { issues: { path: PropertyKey[]; message: string }[] }) {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const k = String(issue.path[0] ?? "");
    if (k && !out[k]) out[k] = issue.message;
  }
  return out;
}
