"use client";

import type { DailyBriefing, Weather } from "@nova/shared";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { SpeakerIcon } from "@/components/dashboard/WeeklyReportCard";
import { Button, Card, Spinner } from "@/components/ui";
import { useSpeechSynthesis } from "@/hooks/useSpeechSynthesis";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { DATA_CHANGED_EVENT, DATA_VERSION_KEY } from "@/lib/events";
import { dueLabel, formatMoney, timeOf, timezone } from "@/lib/format";
import { useVoicePrefs } from "@/lib/prefs";

export function weatherGlyph(condition: string) {
  const c = condition.toLowerCase();
  if (/thunder|storm/.test(c)) return "⛈️";
  if (/snow|sleet/.test(c)) return "🌨️";
  if (/rain|drizzle|shower/.test(c)) return "🌧️";
  if (/fog|mist|haze|smoke/.test(c)) return "🌫️";
  if (/overcast|cloud/.test(c)) return /part|few|scattered/.test(c) ? "⛅" : "☁️";
  if (/clear|sun/.test(c)) return "☀️";
  return "🌤️";
}

/** Fetches GET /briefing and keeps it fresh when data changes anywhere in the app. */
export function useBriefing() {
  const [briefing, setBriefing] = useState<DailyBriefing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setBriefing(await api.briefing.today({ tz: timezone() }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const on = () => void load();
    const onStorage = (e: StorageEvent) => e.key === DATA_VERSION_KEY && on();
    window.addEventListener(DATA_CHANGED_EVENT, on);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(DATA_CHANGED_EVENT, on);
      window.removeEventListener("storage", onStorage);
    };
  }, [load]);

  return { briefing, error, loading, reload: load };
}

export function BriefingCard({ currency, className }: { currency: string; className?: string }) {
  const { briefing: b, error, loading, reload } = useBriefing();
  const tts = useSpeechSynthesis();
  const [prefs] = useVoicePrefs();

  return (
    <Card
      className={cn("relative overflow-hidden border-accent/25", className)}
      title={
        <span className="flex items-center gap-2">
          <span aria-hidden="true" className="size-2 rounded-full bg-accent shadow-[0_0_10px_var(--color-accent)]" />
          Your daily briefing
        </span>
      }
      action={
        b ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={tts.supported === false}
            aria-pressed={tts.speaking}
            onClick={() => (tts.speaking ? tts.cancel() : tts.speak(b.text, { voiceURI: prefs.voiceURI, style: prefs.voiceStyle, rate: prefs.rate, lang: prefs.lang }))}
          >
            <SpeakerIcon />
            {tts.speaking ? "Stop" : "Read aloud"}
          </Button>
        ) : undefined
      }
    >
      <div aria-hidden="true" className="pointer-events-none absolute -right-24 -top-24 size-72 rounded-full bg-[radial-gradient(circle,rgba(94,234,212,0.14),transparent_65%)]" />
      {loading && !b ? (
        <div className="grid h-40 place-items-center text-muted" role="status" aria-label="Loading briefing">
          <Spinner className="size-5" />
        </div>
      ) : error && !b ? (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-danger" role="alert">
          <span>{error}</span>
          <Button size="sm" variant="secondary" onClick={() => void reload()}>
            Retry
          </Button>
        </div>
      ) : b ? (
        <div className="relative grid gap-4 md:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
          <p className="text-sm leading-relaxed text-muted md:col-span-2" aria-live="polite">
            {b.text}
          </p>

          <div className="grid grid-cols-2 gap-3 self-start md:grid-cols-1">
            <WeatherTile weather={b.weather} />
            <div className="grid gap-3 max-md:col-span-1 max-md:grid-cols-1 md:grid-cols-2">
              <MiniStat label="Spent yesterday" value={formatMoney(b.spentYesterday, currency)} />
              <MiniStat label="This month" value={formatMoney(b.spentThisMonth, currency)} accent />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <section aria-labelledby="brief-tasks">
              <h3 id="brief-tasks" className="mb-2 text-xs font-medium uppercase tracking-wider text-faint">
                Tasks due <span className="tabular-nums text-muted">({b.tasksDue.length})</span>
              </h3>
              {b.tasksDue.length ? (
                <ul className="space-y-1.5">
                  {b.tasksDue.slice(0, 5).map((t) => {
                    const due = t.dueDate ? dueLabel(t.dueDate) : null;
                    return (
                      <li key={t.id} className="flex items-center gap-2 text-sm">
                        <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", t.priority === "high" ? "bg-danger" : "bg-line-strong")} />
                        <span className="min-w-0 flex-1 truncate">{t.title}</span>
                        {due && <span className={cn("shrink-0 text-xs", due.tone === "overdue" ? "text-danger" : "text-warn")}>{due.label}</span>}
                      </li>
                    );
                  })}
                  {b.tasksDue.length > 5 && <li className="text-xs text-faint">+{b.tasksDue.length - 5} more below</li>}
                </ul>
              ) : (
                <p className="text-sm text-faint">Nothing due. Nice.</p>
              )}
            </section>

            <section aria-labelledby="brief-reminders">
              <h3 id="brief-reminders" className="mb-2 text-xs font-medium uppercase tracking-wider text-faint">
                Reminders today <span className="tabular-nums text-muted">({b.reminders.length})</span>
              </h3>
              {b.reminders.length ? (
                <ul className="space-y-1.5">
                  {b.reminders.slice(0, 5).map((r) => (
                    <li key={r.id} className={cn("flex items-center gap-2 text-sm", r.done && "text-faint line-through")}>
                      <span className="w-16 shrink-0 text-xs tabular-nums text-accent">{timeOf(r.dateTime)}</span>
                      <span className="min-w-0 flex-1 truncate">{r.text}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-faint">No reminders today.</p>
              )}
            </section>

            {b.budgetAlerts.length > 0 && (
              <section aria-labelledby="brief-budgets" className="sm:col-span-2">
                <h3 id="brief-budgets" className="mb-2 text-xs font-medium uppercase tracking-wider text-faint">
                  Budget alerts
                </h3>
                <ul className="flex flex-wrap gap-2">
                  {b.budgetAlerts.map((a) => (
                    <li
                      key={a.category}
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-xs",
                        a.percentUsed >= 100 ? "border-danger/40 bg-danger/10 text-danger" : "border-warn/40 bg-warn/10 text-warn",
                      )}
                    >
                      {a.category} · {Math.round(a.percentUsed)}% of {formatMoney(a.monthlyLimit, currency, { compact: true })}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function WeatherTile({ weather }: { weather?: Weather }) {
  if (!weather)
    return (
      <div className="rounded-control border border-line bg-surface-2/60 p-3 text-sm">
        <p className="text-xs text-muted">Weather</p>
        <p className="mt-1 text-faint">
          <Link href="/settings" className="text-accent underline-offset-2 hover:underline">
            Set your home city
          </Link>{" "}
          to see it here.
        </p>
      </div>
    );
  return (
    <div className="rounded-control border border-line bg-gradient-to-br from-glow/15 to-surface-2/60 p-3">
      <p className="truncate text-xs text-muted">{weather.city}</p>
      <div className="mt-1 flex items-center gap-2">
        <span aria-hidden="true" className="text-2xl leading-none">
          {weatherGlyph(weather.condition)}
        </span>
        <span className="text-2xl font-semibold tabular-nums">{Math.round(weather.tempC)}°</span>
      </div>
      <p className="mt-1 truncate text-xs text-fg">{weather.condition}</p>
      <p className="text-xs tabular-nums text-faint">
        H {Math.round(weather.highC)}° · L {Math.round(weather.lowC)}° · 💧 {Math.round(weather.rainChance)}%
      </p>
    </div>
  );
}

function MiniStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={cn("rounded-control border border-line bg-surface-2/60 p-3", accent && "border-accent/30")}>
      <p className="text-xs text-muted">{label}</p>
      <p className={cn("mt-1 truncate text-lg font-semibold tabular-nums", accent && "text-accent")}>{value}</p>
    </div>
  );
}
