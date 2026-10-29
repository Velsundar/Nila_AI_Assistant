"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useAuth } from "./AuthProvider";

export function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle: string; children: ReactNode; footer: ReactNode }) {
  const { status } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (status === "authed") router.replace("/today");
  }, [status, router]);

  return (
    <main className="relative grid min-h-dvh place-items-center overflow-hidden bg-void px-4 py-10">
      <div aria-hidden="true" className="pointer-events-none absolute -top-40 left-1/2 size-[36rem] -translate-x-1/2 animate-breathe rounded-full bg-[radial-gradient(circle,rgba(94,234,212,0.18),rgba(129,140,248,0.08)_45%,transparent_70%)]" />
      <div className="relative w-full max-w-sm animate-fade-in">
        <Link href="/" className="mx-auto mb-8 flex w-fit items-center gap-3 rounded-control">
          <span aria-hidden="true" className="relative grid size-10 place-items-center">
            <span className="absolute inset-0 rounded-full bg-accent/40 blur-md" />
            <span className="relative size-8 rounded-full bg-gradient-to-br from-[#e0fffa] via-accent to-indigo-600" />
          </span>
          <span className="text-xl font-semibold tracking-tight">Nova</span>
        </Link>
        <div className="rounded-card border border-line bg-surface/90 p-6 shadow-2xl shadow-black/40 backdrop-blur sm:p-7">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 text-sm text-muted">{subtitle}</p>
          <div className="mt-6">{children}</div>
        </div>
        <p className="mt-6 text-center text-sm text-muted">{footer}</p>
      </div>
    </main>
  );
}
