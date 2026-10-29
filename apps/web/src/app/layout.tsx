import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { AuthProvider } from "@/components/AuthProvider";
import "./globals.css";

// Render per request so Next can stamp the CSP nonce (set in middleware.ts) on its scripts.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "Nova", template: "%s · Nova" },
  description: "Voice-first expense tracker and personal AI assistant.",
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = {
  themeColor: "#080b14",
  width: "device-width",
  initialScale: 1,
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-bg text-fg antialiased">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
