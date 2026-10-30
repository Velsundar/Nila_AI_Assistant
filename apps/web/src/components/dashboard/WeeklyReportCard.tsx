"use client";

import type { WeeklyReport } from "@nova/shared";
import { useCallback, useEffect, useState } from "react";
import { Button, Card, Spinner } from "@/components/ui";
import { useSpeechSynthesis } from "@/hooks/useSpeechSynthesis";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { DATA_CHANGED_EVENT } from "@/lib/events";
import { dayRangeLabel, formatMoney, timezone } from "@/lib/format";
import { useVoicePrefs } from "@/lib/prefs";

/** Last completed Mon–Sun week: total, change vs the week before, top categories and merchants. */
export function WeeklyReportCard({ currency, className }: { currency: string; className?: string }) {
  const [report, setReport] = useState<WeeklyReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const tts = useSpeechSynthesis();
  const [prefs] = useVoicePrefs();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReport(await api.reports.weekly({ tz: timezone() }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const on = () => void load();
    window.addEventListener(DATA_CHANGED_EVENT, on);
    return () => window.removeEventListener(DATA_CHANGED_EVENT, on);
  }, [load]);

  const change = report?.changePercent;
  const up = change !== null && change !== undefined && change > 0;
  const maxCat = Math.max(1, ...(report?.byCategory.map((c) => c.total) ?? [1]));

  return (
    <Card
      title="Weekly report"
      className={className}
      action={
        report ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={tts.supported === false || !report.text}
            aria-pressed={tts.speaking}
            onClick={() => (tts.speaking ? tts.cancel() : tts.speak(report.text, { voiceURI: prefs.voiceURI, style: prefs.voiceStyle, rate: prefs.rate, lang: prefs.lang }))}
          >
            <SpeakerIcon />
            {tts.speaking ? "Stop" : "Read it to me"}
          </Button>
        ) : undefined
      }
    >
      {loading && !report ? (
        <div className="grid h-40 place-items-center text-muted" role="status" aria-label="Loading weekly report">
          <Spinner className="size-5" />
        </div>
      ) : error ? (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-danger" role="alert">
          <span>{error}</span>
          <Button size="sm" variant="secondary" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : report ? (
        <div className="grid gap-5 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_minmax(0,1fr)]">
          <div>
            <p className="text-xs text-muted">{dayRangeLabel(report.weekStart, report.weekEnd)}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-fg">{formatMoney(report.total, currency)}</p>
            <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
              {change === null || change === undefined ? (
                <span>No spending the week before</span>
              ) : (
                <>
                  <span
                    className={cn(
                      "inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 font-medium tabular-nums",
                      up ? "border-warn/40 bg-warn/10 text-warn" : "border-ok/40 bg-ok/10 text-ok",
                    )}
                  >
                    <span aria-hidden="true">{up ? "▲" : change < 0 ? "▼" : "■"}</span>
                    <span className="sr-only">{up ? "up" : change < 0 ? "down" : "unchanged"}</span>
                    {Math.abs(Math.round(change))}%
                  </span>
                  <span>vs {formatMoney(report.previousTotal, currency)} the week before</span>
                </>
              )}
            </p>
          </div>

          <div>
            <h3 className="mb-2 text-xs font-medium text-muted">Top categories</h3>
            {report.byCategory.length ? (
              <ul className="space-y-2">
                {[...report.byCategory]
                  .sort((a, b) => b.total - a.total)
                  .slice(0, 4)
                  .map((c) => (
                    <li key={c.category}>
                      <div className="flex justify-between gap-2 text-sm">
                        <span className="truncate">{c.category}</span>
                        <span className="shrink-0 tabular-nums text-muted">{formatMoney(c.total, currency)}</span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3" aria-hidden="true">
                        <div className="h-full rounded-full bg-accent/80" style={{ width: `${Math.max(3, (c.total / maxCat) * 100)}%` }} />
                      </div>
                    </li>
                  ))}
              </ul>
            ) : (
              <p className="text-sm text-faint">Nothing spent that week.</p>
            )}
          </div>

          <div>
            <h3 className="mb-2 text-xs font-medium text-muted">Top merchants</h3>
            {report.topMerchants.length ? (
              <ol className="space-y-1.5">
                {report.topMerchants.slice(0, 4).map((m, i) => (
                  <li key={m.merchant} className="flex items-center gap-2 text-sm">
                    <span aria-hidden="true" className="grid size-5 shrink-0 place-items-center rounded-full bg-surface-3 text-[10px] font-semibold text-muted">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{m.merchant}</span>
                    <span className="shrink-0 text-xs text-faint">×{m.count}</span>
                    <span className="shrink-0 tabular-nums text-muted">{formatMoney(m.total, currency)}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-faint">No merchants recorded.</p>
            )}
          </div>
        </div>
      ) : null}
    </Card>
  );
}

export function SpeakerIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 5 6 9H3v6h3l5 4V5Zm4.5 3.5a5 5 0 0 1 0 7M18 6a8.5 8.5 0 0 1 0 12" />
    </svg>
  );
}
