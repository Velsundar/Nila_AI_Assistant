"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { BriefingCard } from "@/components/today/BriefingCard";
import { NotesCard } from "@/components/today/NotesCard";
import { TasksCard } from "@/components/today/TasksCard";

function greeting(h: number) {
  return h < 5 ? "Good evening" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

export default function TodayPage() {
  const { user } = useAuth();
  const currency = user?.currency || "INR";
  const name = user?.assistantName || "Nila";
  // Time-of-day text only on the client so SSR markup stays stable.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-16 pt-6 sm:px-6">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-accent/80">
            {now ? now.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" }) : "Today"}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            {now ? greeting(now.getHours()) : "Hello"}
            {user?.name ? `, ${user.name.split(" ")[0]}` : ""}
          </h1>
        </div>
        <Link
          href="/assistant"
          className="inline-flex h-10 items-center gap-2 rounded-full border border-accent/40 bg-accent/10 px-4 text-sm font-medium text-accent transition-colors hover:bg-accent/20"
        >
          <span aria-hidden="true" className="size-4 rounded-full bg-gradient-to-br from-[#e0fffa] via-accent to-indigo-600 shadow-[0_0_10px_var(--color-accent)]" />
          Talk to {name}
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <BriefingCard currency={currency} className="lg:col-span-3" />
        <TasksCard className="lg:col-span-2" />
        <NotesCard className="lg:col-span-1" />
      </div>
    </main>
  );
}
