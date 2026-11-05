import { NextResponse, type NextRequest } from "next/server";

/**
 * Per-request nonce + strict Content-Security-Policy. The JWT lives in localStorage, so the main
 * defence against token theft is not letting injected scripts run: only scripts carrying this
 * request's nonce (Next's own runtime/inline chunks) execute. Pages are rendered per request
 * (see `dynamic` in app/layout.tsx) so Next can stamp the nonce on its scripts.
 */
export function middleware(req: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const dev = process.env.NODE_ENV !== "production";
  const api = apiOrigin();
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    // React/recharts set inline style attributes; styles can't run code.
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self'${api ? ` ${api}` : ""}${dev ? " ws: wss:" : ""}`,
    "img-src 'self' data: blob:",
    // Natural-voice clips play from blob: URLs (decoded from the API's data:audio/wav). data: is
    // allowed too so a clip can also be played straight from the API response if ever needed.
    "media-src 'self' blob: data:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");

  const headers = new Headers(req.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp); // Next reads the nonce from here while rendering
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("Content-Security-Policy", csp);
  return res;
}

function apiOrigin() {
  const raw = process.env.NEXT_PUBLIC_API_URL || (process.env.NODE_ENV !== "production" ? "http://localhost:4000" : "");
  try {
    return raw ? new URL(raw).origin : "";
  } catch {
    return "";
  }
}

export const config = {
  // Documents only: skip static assets and prefetches.
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico|logo.png|apple-touch-icon.png).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
