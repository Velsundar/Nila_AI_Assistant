"use client";

import type { TrendsResult } from "@nova/shared";
import { Card } from "@/components/ui";
import { cn } from "@/lib/cn";
import { formatMoney } from "@/lib/format";
import { monthShort, TrendBars } from "./Charts";

const pct = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(Math.round(n))}%`;

/**
 * Six months of received / spent / invested, savings rate per month, this month vs last and the
 * categories that moved most. Rendered only when GET /insights/trends succeeded.
 */
export function TrendsCard({ trends, currency, className }: { trends: TrendsResult; currency: string; className?: string }) {
  const change = trends.spentChangePercent;
  const movers = [...trends.categoryChanges]
    .filter((c) => c.thisMonth !== c.lastMonth)
    .sort((a, b) => Math.abs(b.thisMonth - b.lastMonth) - Math.abs(a.thisMonth - a.lastMonth))
    .slice(0, 4);

  return (
    <Card title="Trends & savings" className={className} action={<span className="text-xs text-faint">Last {trends.months.length} months</span>}>
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="min-w-0 rounded-control border border-line bg-surface-2/60 p-3">
          <p className="text-xs text-muted">Spending vs last month</p>
          <p className={cn("mt-1 truncate text-lg font-semibold tabular-nums", change !== null && change > 0 && "text-danger", change !== null && change < 0 && "text-ok")}>
            {change === null ? "—" : pct(change)}
          </p>
        </div>
        <div className="min-w-0 rounded-control border border-line bg-surface-2/60 p-3">
          <p className="text-xs text-muted">Average monthly spend</p>
          <p className="mt-1 truncate text-lg font-semibold tabular-nums">{formatMoney(trends.averageMonthlySpent, currency)}</p>
        </div>
        <div className="col-span-2 min-w-0 rounded-control border border-line bg-surface-2/60 p-3 sm:col-span-1">
          <p className="text-xs text-muted">Savings rate this month</p>
          <p className="mt-1 truncate text-lg font-semibold tabular-nums">
            {(() => {
              const r = trends.months.at(-1)?.savingsRate;
              return r === null || r === undefined ? "—" : `${r}%`;
            })()}
          </p>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <TrendBars months={trends.months} currency={currency} />

        <section aria-labelledby="movers-title" className="min-w-0">
          <h3 id="movers-title" className="mb-2 text-xs font-medium uppercase tracking-wider text-faint">
            Top movers vs last month
          </h3>
          {movers.length ? (
            <ul className="grid gap-2 text-sm">
              {movers.map((c) => {
                const up = c.thisMonth > c.lastMonth;
                return (
                  <li key={c.category} className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-fg">{c.category}</span>
                    <span className="shrink-0 text-xs tabular-nums text-faint">
                      {formatMoney(c.lastMonth, currency, { compact: true })} → {formatMoney(c.thisMonth, currency, { compact: true })}
                    </span>
                    <span className={cn("w-14 shrink-0 text-right text-xs font-medium tabular-nums", up ? "text-danger" : "text-ok")}>
                      <span aria-hidden="true">{up ? "▲" : "▼"} </span>
                      <span className="sr-only">{up ? "up" : "down"} </span>
                      {c.changePercent === null ? "new" : `${Math.abs(Math.round(c.changePercent))}%`}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-faint">No category changes vs last month yet.</p>
          )}
        </section>
      </div>

      {/* The numbers behind the chart, including the savings rate (a % on its own row, not a second axis). */}
      <div className="mt-5 overflow-x-auto">
        <table className="w-full min-w-0 text-right text-xs tabular-nums">
          <caption className="sr-only">Money per month</caption>
          <thead className="text-faint">
            <tr>
              <th scope="col" className="py-1 text-left font-medium">Month</th>
              <th scope="col" className="py-1 font-medium">Received</th>
              <th scope="col" className="py-1 font-medium">Spent</th>
              <th scope="col" className="py-1 font-medium max-sm:hidden">Invested</th>
              <th scope="col" className="py-1 font-medium">Saved</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/50 text-muted">
            {trends.months.map((m) => (
              <tr key={m.month}>
                <th scope="row" className="py-1.5 text-left font-normal text-fg">{monthShort(m.month)}</th>
                <td className="py-1.5">{formatMoney(m.received, currency, { compact: true })}</td>
                <td className="py-1.5">{formatMoney(m.spent, currency, { compact: true })}</td>
                <td className="py-1.5 max-sm:hidden">{formatMoney(m.invested, currency, { compact: true })}</td>
                <td className={cn("py-1.5", m.saved < 0 ? "text-danger" : "text-fg")}>
                  {formatMoney(m.saved, currency, { compact: true })}
                  <span className="ml-1 text-faint">{m.savingsRate === null ? "" : `${m.savingsRate}%`}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
