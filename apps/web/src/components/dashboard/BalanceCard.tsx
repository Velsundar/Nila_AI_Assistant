"use client";

import type { Ledger } from "@nova/shared";
import { Card } from "@/components/ui";
import { cn } from "@/lib/cn";
import { formatMoney, shortDate } from "@/lib/format";

function periodLabel(l: Ledger) {
  const from = new Date(l.from);
  const day = from.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  if (l.period === "salary-cycle") return `Since salary on ${day}`;
  if (l.period === "month") {
    const now = new Date();
    const same = from.getFullYear() === now.getFullYear() && from.getMonth() === now.getMonth();
    return same ? "This month" : from.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  }
  return `${day} – ${shortDate(l.to)}`;
}

const signed = (n: number, currency: string) => (n > 0 ? `+${formatMoney(n, currency)}` : n < 0 ? `−${formatMoney(-n, currency)}` : formatMoney(0, currency));

/**
 * Salary-cycle passbook: money in and out, oldest first, with the running balance. Rendered only when
 * GET /ledger succeeded (the dashboard hides it on an older API).
 */
export function BalanceCard({ ledger, currency, className }: { ledger: Ledger; currency: string; className?: string }) {
  const t = ledger.totals;
  return (
    <Card
      title="Balance"
      className={className}
      action={<span className="text-xs text-faint">{periodLabel(ledger)}</span>}
    >
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Received" value={formatMoney(t.received, currency)} tone="ok" />
        <Tile label="Spent" value={formatMoney(t.spent, currency)} />
        <Tile label="Invested" value={formatMoney(t.invested, currency)} />
        <Tile label="Balance (left)" value={formatMoney(t.balance, currency)} tone={t.balance < 0 ? "danger" : "accent"} />
      </dl>

      {ledger.entries.length ? (
        <div className="mt-4">
          {/* Column headers (wide screens only; on mobile each entry is two lines). */}
          <div className="hidden grid-cols-[4.5rem_minmax(0,1fr)_7.5rem_7.5rem] gap-3 border-b border-line px-2 pb-1.5 text-[11px] font-medium uppercase tracking-wider text-faint sm:grid" aria-hidden="true">
            <span>Date</span>
            <span>Details</span>
            <span className="text-right">In / out</span>
            <span className="text-right">Balance</span>
          </div>
          <ol className="-mx-2 max-h-[24rem] divide-y divide-line/60 overflow-y-auto" aria-label="Passbook, oldest first">
            {ledger.entries.map((e) => {
              const isIn = e.amount > 0;
              const detail = [e.category, e.subcategory].filter(Boolean).join(" · ");
              return (
                <li key={`${e.kind}-${e.id}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 px-4 py-2 text-sm sm:grid-cols-[4.5rem_minmax(0,1fr)_7.5rem_7.5rem] sm:items-center">
                  <span className="text-xs tabular-nums text-faint max-sm:col-start-1 max-sm:row-start-2 sm:text-sm sm:text-muted">
                    <span className="sm:hidden">{shortDate(e.date)} · {detail}</span>
                    <span className="max-sm:hidden">{shortDate(e.date)}</span>
                  </span>
                  <span className="min-w-0 max-sm:col-start-1 max-sm:row-start-1">
                    <span className="block truncate text-fg">{e.label}</span>
                    <span className="block truncate text-xs text-faint max-sm:hidden">{detail}</span>
                  </span>
                  <span className={cn("text-right font-medium tabular-nums max-sm:col-start-2 max-sm:row-start-1", isIn ? "text-ok" : "text-fg")}>
                    <span className="sr-only">{isIn ? "In " : "Out "}</span>
                    {signed(e.amount, currency)}
                  </span>
                  <span className={cn("text-right text-xs tabular-nums max-sm:col-start-2 max-sm:row-start-2 sm:text-sm", e.balance < 0 ? "text-danger" : "text-muted")}>
                    <span className="sr-only">Balance </span>
                    <span className="sm:hidden" aria-hidden="true">= </span>
                    {formatMoney(e.balance, currency)}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      ) : (
        <p className="mt-4 py-6 text-center text-sm text-faint">Nothing in or out yet this cycle. Log your salary to start one.</p>
      )}
    </Card>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: "ok" | "danger" | "accent" }) {
  return (
    <div className={cn("min-w-0 rounded-control border border-line bg-surface-2/60 p-3", tone === "accent" && "border-accent/30")}>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={cn("mt-1 truncate text-lg font-semibold tabular-nums", tone === "ok" && "text-ok", tone === "danger" && "text-danger", tone === "accent" && "text-accent")}>{value}</dd>
    </div>
  );
}
