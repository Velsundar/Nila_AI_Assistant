import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  // Mic for voice, camera for receipt photos; nothing else.
  { key: "Permissions-Policy", value: "microphone=(self), camera=(self), geolocation=(), payment=(), usb=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

export default function config(phase: string): NextConfig {
  // NEXT_PUBLIC_API_URL is inlined at build time: never ship a production build pointing at localhost by accident.
  if (phase === PHASE_PRODUCTION_BUILD && !process.env.NEXT_PUBLIC_API_URL) {
    throw new Error(
      "NEXT_PUBLIC_API_URL is required for a production build (e.g. NEXT_PUBLIC_API_URL=https://api.example.com pnpm --filter @nova/web build).",
    );
  }
  return {
    // A separate build dir (NEXT_DIST_DIR=.next-prod) lets a production build run beside `next dev`.
    distDir: process.env.NEXT_DIST_DIR || ".next",
    reactStrictMode: true,
    poweredByHeader: false,
    transpilePackages: ["@nova/shared"],
    async headers() {
      return [{ source: "/:path*", headers: securityHeaders }];
    },
  };
}
