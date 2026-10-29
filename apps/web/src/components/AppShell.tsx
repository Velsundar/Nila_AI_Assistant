"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { useAuth } from "./AuthProvider";
import { FullScreenLoader } from "./ui";

const NAV = [
  { href: "/assistant", label: "Assistant", icon: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Zm7 9a7 7 0 0 1-14 0m7 7v2" },
  { href: "/dashboard", label: "Dashboard", icon: "M4 20V10m6 10V4m6 16v-7m4 7H2" },
  { href: "/settings", label: "Settings", icon: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-2-1.2L14.5 3h-4l-.4 2.6a7.5 7.5 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 2 1.2l.4 2.6h4l.4-2.6a7.5 7.5 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z" },
];

/** Guards every signed-in page and renders the top navigation. */
export function AppShell({ children }: { children: ReactNode }) {
  const { status, user, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === "anon") router.replace(`/login`);
  }, [status, router]);

  if (status !== "authed" || !user) return <FullScreenLoader />;

  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <header className="sticky top-0 z-30 border-b border-line/70 bg-void/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-2 px-3 sm:px-6">
          <Link href="/assistant" className="mr-auto flex items-center gap-2.5 rounded-control pr-2" aria-label={`${user.assistantName} home`}>
            <span aria-hidden="true" className="relative grid size-7 place-items-center">
              <span className="absolute inset-0 rounded-full bg-accent/40 blur-[6px]" />
              <span className="relative size-6 rounded-full bg-gradient-to-br from-[#e0fffa] via-accent to-indigo-600" />
            </span>
            <span className="hidden font-semibold tracking-tight sm:inline">Nova</span>
          </Link>
          <nav aria-label="Main" className="flex items-center gap-1">
            {NAV.map((item) => {
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex h-9 items-center gap-2 rounded-control px-2.5 text-sm transition-colors sm:px-3",
                    active ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface-2/60 hover:text-fg",
                  )}
                >
                  <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d={item.icon} />
                  </svg>
                  <span className="max-[420px]:sr-only">{item.label}</span>
                </Link>
              );
            })}
          </nav>
          <button
            type="button"
            onClick={() => {
              logout();
              router.replace("/login");
            }}
            className="ml-1 flex h-9 items-center rounded-control px-2.5 text-sm text-muted transition-colors hover:bg-surface-2/60 hover:text-fg"
            aria-label="Sign out"
            title="Sign out"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10" />
            </svg>
          </button>
        </div>
      </header>
      {children}
    </div>
  );
}
