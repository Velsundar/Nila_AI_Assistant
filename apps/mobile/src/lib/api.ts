import Constants from "expo-constants";
import { ApiError, createApiClient } from "@nova/shared";

/**
 * Resolve the API base URL:
 * 1. EXPO_PUBLIC_API_URL if set (inlined at bundle time).
 * 2. In development, the dev machine's LAN IP (the host Metro is served from) + :4000,
 *    so a real phone on the same Wi-Fi reaches the API without any config.
 * 3. http://localhost:4000 (iOS simulator / web).
 */
function resolveBaseUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  const hostUri = Constants.expoConfig?.hostUri; // e.g. "192.168.1.20:8081"
  const host = hostUri?.split(":")[0];
  if (host && host !== "localhost" && host !== "127.0.0.1") return `http://${host}:4000`;
  return "http://localhost:4000";
}

export const API_BASE_URL = resolveBaseUrl();

// The token lives in memory for synchronous-ish access; SecureStore is the persistent copy (see auth.tsx).
let currentToken: string | null = null;
let unauthorizedHandler: (() => void) | null = null;

export function setApiToken(token: string | null) {
  currentToken = token;
}
export function setUnauthorizedHandler(fn: (() => void) | null) {
  unauthorizedHandler = fn;
}

export const api = createApiClient({
  baseUrl: API_BASE_URL,
  getToken: () => currentToken,
  onUnauthorized: () => unauthorizedHandler?.(),
});

/** Human-friendly message for any error thrown by the api client or fetch. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message || `Request failed (${err.status})`;
  if (err instanceof TypeError || (err instanceof Error && /network/i.test(err.message))) {
    return `Can't reach the Nova API at ${API_BASE_URL}. Is it running, and is your phone on the same Wi-Fi?`;
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
