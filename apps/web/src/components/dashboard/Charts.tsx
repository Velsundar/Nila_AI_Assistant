"use client";

import type { SpendingSummary } from "@nova/shared";
import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatMoney } from "@/lib/format";

/** Categorical slots validated (dataviz validator) against the dark surface #0e1322. */
const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9"];
const OTHER = "#6b7496";

type Slice = { name: string; value: number; count: number; color: string };

function TooltipBox({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-control border border-line-strong bg-surface-3/95 px-3 py-2 text-xs shadow-xl">
      <div className="text-muted">{title}</div>
      <div className="mt-0.5 font-semibold text-fg tabular-nums">{value}</div>
    </div>
  );
}

export function CategoryDonut({ summary, currency }: { summary: SpendingSummary; currency: string }) {
  const slices = useMemo<Slice[]>(() => {
    const sorted = [...summary.byCategory].filter((c) => c.total > 0).sort((a, b) => b.total - a.total);
    // More categories than validated slots fold into a neutral "Other" slice.
    const head = sorted.length > SERIES.length ? sorted.slice(0, SERIES.length - 1) : sorted;
    const tail = sorted.slice(head.length);
    const out: Slice[] = head.map((c, i) => ({ name: c.category, value: c.total, count: c.count, color: SERIES[i] }));
    if (tail.length)
      out.push({
        name: `Other (${tail.map((t) => t.category).join(", ")})`,
        value: tail.reduce((s, t) => s + t.total, 0),
        count: tail.reduce((s, t) => s + t.count, 0),
        color: OTHER,
      });
    return out;
  }, [summary.byCategory]);

  if (!slices.length) return <Empty>No spending this month yet.</Empty>;
  const total = slices.reduce((s, x) => s + x.value, 0);

  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row lg:flex-col">
      <div className="relative h-48 w-48 shrink-0" role="img" aria-label={`Spend by category: ${slices.map((s) => `${s.name} ${formatMoney(s.value, currency)}`).join(", ")}`}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={slices} dataKey="value" nameKey="name" innerRadius="64%" outerRadius="100%" paddingAngle={slices.length > 1 ? 1.5 : 0} stroke="var(--color-surface)" strokeWidth={2} cornerRadius={4} isAnimationActive={false}>
              {slices.map((s) => (
                <Cell key={s.name} fill={s.color} />
              ))}
            </Pie>
            <Tooltip
              cursor={false}
              content={({ active, payload }) =>
                active && payload?.[0] ? (
                  <TooltipBox title={String(payload[0].name)} value={`${formatMoney(Number(payload[0].value), currency)} · ${Math.round((Number(payload[0].value) / total) * 100)}%`} />
                ) : null
              }
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-faint">Total</div>
            <div className="text-base font-semibold tabular-nums">{formatMoney(total, currency, { compact: true })}</div>
          </div>
        </div>
      </div>
      <ul className="grid w-full min-w-0 gap-2 text-sm">
        {slices.map((s) => (
          <li key={s.name} className="flex items-center gap-2.5">
            <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
            <span className="min-w-0 flex-1 truncate text-muted" title={s.name}>
              {s.name}
            </span>
            <span className="tabular-nums text-fg">{formatMoney(s.value, currency)}</span>
            <span className="w-10 text-right text-xs tabular-nums text-faint">{Math.round((s.value / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DailyBars({ summary, currency, days, monthKey }: { summary: SpendingSummary; currency: string; days: number; monthKey: string }) {
  const data = useMemo(() => {
    const byDate = new Map(summary.byDay.map((d) => [d.date.slice(0, 10), d.total]));
    return Array.from({ length: days }, (_, i) => {
      const date = `${monthKey}-${String(i + 1).padStart(2, "0")}`;
      return { day: i + 1, date, total: byDate.get(date) ?? 0 };
    });
  }, [summary.byDay, days, monthKey]);

  if (!data.some((d) => d.total > 0)) return <Empty>Nothing spent on any day yet.</Empty>;

  return (
    <div className="h-56 w-full" role="img" aria-label="Spend by day of month">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 6, right: 4, left: -8, bottom: 0 }} barCategoryGap={2}>
          <CartesianGrid vertical={false} stroke="var(--color-line)" strokeOpacity={0.6} />
          <XAxis dataKey="day" tickLine={false} axisLine={false} tick={{ fill: "var(--color-faint)", fontSize: 11 }} interval="preserveStartEnd" minTickGap={10} />
          <YAxis tickLine={false} axisLine={false} width={48} tick={{ fill: "var(--color-faint)", fontSize: 11 }} tickFormatter={(v: number) => formatMoney(v, currency, { compact: true })} />
          <Tooltip
            cursor={{ fill: "var(--color-surface-3)", opacity: 0.6 }}
            content={({ active, payload }) =>
              active && payload?.[0] ? (
                <TooltipBox
                  title={new Date(`${(payload[0].payload as { date: string }).date}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}
                  value={formatMoney(Number(payload[0].value), currency)}
                />
              ) : null
            }
          />
          <Bar dataKey="total" fill="var(--color-accent-strong)" radius={[4, 4, 0, 0]} maxBarSize={22} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="grid h-40 place-items-center rounded-control border border-dashed border-line text-sm text-faint">{children}</div>;
}
