"use client";

import { CATEGORIES, type Category, type SpendingSummary, type TrendsResult } from "@nova/shared";
import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { cn } from "@/lib/cn";
import { formatMoney } from "@/lib/format";

/** Categorical slots validated (dataviz validator) against the dark surface #0e1322. */
export const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9"] as const;
const [BLUE, ORANGE, AQUA, YELLOW, MAGENTA, GREEN, VIOLET] = SERIES;
export const OTHER = "#6b7496";

/**
 * Each category owns a preferred hue, so a colour follows the category, never its rank: deleting an
 * expense can't repaint the surviving slices. 14 named categories share 7 validated hues, so when two
 * categories with the same preference are on screen together the one later in CATEGORIES takes the next
 * free hue (deterministic, CATEGORIES order rather than size order). "Other" is always the neutral.
 */
const PREFERRED: Record<Category, string> = {
  Food: ORANGE,
  Groceries: GREEN,
  Shopping: MAGENTA,
  Housing: YELLOW,
  Rent: VIOLET,
  Transportation: BLUE,
  Vehicle: AQUA,
  Bills: YELLOW,
  "Life & Entertainment": VIOLET,
  Health: AQUA,
  Education: BLUE,
  Travel: MAGENTA,
  Investments: GREEN,
  "Savings & Insurance": AQUA,
  Other: OTHER,
};

/** Distinct colours for the categories currently shown (≤ 7 named ones). */
export function categoryColors(shown: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  const ordered = [...shown].sort((a, b) => CATEGORIES.indexOf(a as Category) - CATEGORIES.indexOf(b as Category));
  for (const c of ordered) {
    if (c === "Other" || !(c in PREFERRED)) {
      out.set(c, OTHER);
      continue;
    }
    const pref = PREFERRED[c as Category];
    const start = SERIES.indexOf(pref as (typeof SERIES)[number]);
    let pick: string = OTHER;
    for (let i = 0; i < SERIES.length; i++) {
      const cand = SERIES[(start + i) % SERIES.length];
      if (!used.has(cand)) {
        pick = cand;
        break;
      }
    }
    used.add(pick);
    out.set(c, pick);
  }
  return out;
}

/** The colour a single category gets on its own (e.g. for its subcategory panel). */
export const categoryColor = (c: string) => (c in PREFERRED ? PREFERRED[c as Category] : OTHER);

type Slice = { name: string; category: Category | null; value: number; count: number; color: string };

function TooltipBox({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-control border border-line-strong bg-surface-3/95 px-3 py-2 text-xs shadow-xl">
      <div className="text-muted">{title}</div>
      <div className="mt-0.5 font-semibold text-fg tabular-nums">{value}</div>
    </div>
  );
}

/** Named slices shown before the rest fold into "Other". */
const MAX_NAMED = SERIES.length - 1;

export function CategoryDonut({
  summary,
  currency,
  selected,
  onSelect,
}: {
  summary: SpendingSummary;
  currency: string;
  selected?: Category | null;
  /** Click a slice / legend row to drill into that category (null clears). */
  onSelect?: (c: Category | null) => void;
}) {
  const slices = useMemo<Slice[]>(() => {
    const sorted = summary.byCategory.filter((c) => c.total > 0).sort((a, b) => b.total - a.total);
    const named = sorted.filter((c) => c.category !== "Other");
    const head = named.length > MAX_NAMED + 1 ? named.slice(0, MAX_NAMED) : named;
    const tail = sorted.filter((c) => !head.includes(c));
    const colors = categoryColors(head.map((c) => c.category));
    const out: Slice[] = head.map((c) => ({ name: c.category, category: c.category, value: c.total, count: c.count, color: colors.get(c.category) ?? OTHER }));
    if (tail.length) {
      const onlyOther = tail.length === 1 ? tail[0] : null;
      out.push({
        name: onlyOther ? onlyOther.category : `Other (${tail.map((t) => t.category).join(", ")})`,
        category: onlyOther ? onlyOther.category : null,
        value: tail.reduce((s, t) => s + t.total, 0),
        count: tail.reduce((s, t) => s + t.count, 0),
        color: OTHER,
      });
    }
    return out;
  }, [summary.byCategory]);

  if (!slices.length) return <Empty>No spending this month yet.</Empty>;
  const total = slices.reduce((s, x) => s + x.value, 0);
  const pick = (s: Slice) => s.category && onSelect?.(selected === s.category ? null : s.category);

  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row lg:flex-col">
      <div className="relative h-48 w-48 shrink-0" role="img" aria-label={`Spend by category: ${slices.map((s) => `${s.name} ${formatMoney(s.value, currency)}`).join(", ")}`}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices}
              dataKey="value"
              nameKey="name"
              innerRadius="64%"
              outerRadius="100%"
              paddingAngle={slices.length > 1 ? 1.5 : 0}
              stroke="var(--color-surface)"
              strokeWidth={2}
              cornerRadius={4}
              isAnimationActive={false}
              onClick={(_, i) => slices[i] && pick(slices[i])}
              className={onSelect ? "cursor-pointer" : undefined}
            >
              {slices.map((s) => (
                <Cell key={s.name} fill={s.color} fillOpacity={selected && s.category !== selected ? 0.35 : 1} />
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
      <ul className="grid w-full min-w-0 gap-1 text-sm">
        {slices.map((s) => {
          const inner = (
            <>
              <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
              <span className="min-w-0 flex-1 truncate text-left text-muted" title={s.name}>
                {s.name}
              </span>
              <span className="tabular-nums text-fg">{formatMoney(s.value, currency)}</span>
              <span className="w-10 text-right text-xs tabular-nums text-faint">{Math.round((s.value / total) * 100)}%</span>
            </>
          );
          return (
            <li key={s.name}>
              {onSelect && s.category ? (
                <button
                  type="button"
                  onClick={() => pick(s)}
                  aria-pressed={selected === s.category}
                  aria-label={`${s.name}: ${formatMoney(s.value, currency)}. Show subcategories`}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-control px-1.5 py-1 transition-colors hover:bg-surface-2",
                    selected === s.category && "bg-surface-2 ring-1 ring-line-strong",
                  )}
                >
                  {inner}
                </button>
              ) : (
                <div className="flex items-center gap-2.5 px-1.5 py-1">{inner}</div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** One category's subcategory split, as a ranked bar list in the category's own colour. */
export function SubcategorySplit({
  category,
  rows,
  currency,
  loading,
  error,
}: {
  category: Category;
  rows: { subcategory: string; total: number; count: number }[] | null;
  currency: string;
  loading?: boolean;
  error?: string | null;
}) {
  const color = categoryColor(category);
  if (error) return <p className="text-sm text-faint">{error}</p>;
  if (!rows) return <p className="text-sm text-faint" role="status">{loading ? "Loading…" : ""}</p>;
  if (!rows.length) return <p className="text-sm text-faint">No {category} spending this month.</p>;
  const sorted = [...rows].sort((a, b) => b.total - a.total);
  const max = Math.max(1, ...sorted.map((r) => r.total));
  const total = sorted.reduce((s, r) => s + r.total, 0);
  return (
    <ul className={cn("grid gap-2.5 transition-opacity", loading && "opacity-60")} aria-label={`${category} by subcategory`}>
      {sorted.map((r) => (
        <li key={r.subcategory} className="min-w-0">
          <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
            <span className="min-w-0 truncate text-fg">{r.subcategory}</span>
            <span className="shrink-0 tabular-nums text-muted">
              <span className="text-fg">{formatMoney(r.total, currency)}</span> · {Math.round((r.total / total) * 100)}%
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-3" aria-hidden="true">
            <div className="h-full rounded-full" style={{ width: `${Math.max(2, (r.total / max) * 100)}%`, background: color }} />
          </div>
          <div className="mt-0.5 text-[11px] text-faint">
            {r.count} expense{r.count === 1 ? "" : "s"}
          </div>
        </li>
      ))}
    </ul>
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

/** Received / spent / invested per month: the first three validated slots (they pass all-pairs). */
export const TREND_SERIES = [
  { key: "received", label: "Received", color: BLUE },
  { key: "spent", label: "Spent", color: ORANGE },
  { key: "invested", label: "Invested", color: AQUA },
] as const;

export function monthShort(key: string, withYear = false) {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month: "short", ...(withYear ? { year: "numeric" } : {}) });
}

export function TrendBars({ months, currency }: { months: TrendsResult["months"]; currency: string }) {
  const data = useMemo(() => months.map((m) => ({ ...m, label: monthShort(m.month) })), [months]);
  if (!months.some((m) => m.received || m.spent || m.invested)) return <Empty>No money in or out in these months yet.</Empty>;
  return (
    <div>
      <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-label="Legend">
        {TREND_SERIES.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span aria-hidden="true" className="size-2.5 rounded-sm" style={{ background: s.color }} />
            {s.label}
          </li>
        ))}
      </ul>
      <div className="h-56 w-full" role="img" aria-label={`Received, spent and invested per month: ${months.map((m) => `${monthShort(m.month)} received ${formatMoney(m.received, currency)}, spent ${formatMoney(m.spent, currency)}, invested ${formatMoney(m.invested, currency)}`).join("; ")}`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 6, right: 4, left: -8, bottom: 0 }} barGap={2} barCategoryGap="22%">
            <CartesianGrid vertical={false} stroke="var(--color-line)" strokeOpacity={0.6} />
            <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: "var(--color-faint)", fontSize: 11 }} />
            <YAxis tickLine={false} axisLine={false} width={48} tick={{ fill: "var(--color-faint)", fontSize: 11 }} tickFormatter={(v: number) => formatMoney(v, currency, { compact: true })} />
            <Tooltip
              cursor={{ fill: "var(--color-surface-3)", opacity: 0.6 }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const m = payload[0].payload as (typeof data)[number];
                return (
                  <div className="rounded-control border border-line-strong bg-surface-3/95 px-3 py-2 text-xs shadow-xl">
                    <div className="mb-1 text-muted">{monthShort(m.month, true)}</div>
                    {TREND_SERIES.map((s) => (
                      <div key={s.key} className="flex items-center gap-2">
                        <span aria-hidden="true" className="size-2 rounded-sm" style={{ background: s.color }} />
                        <span className="flex-1 text-muted">{s.label}</span>
                        <span className="font-semibold tabular-nums text-fg">{formatMoney(m[s.key], currency)}</span>
                      </div>
                    ))}
                    {m.savingsRate !== null && <div className="mt-1 text-muted">Saved {m.savingsRate}% of income</div>}
                  </div>
                );
              }}
            />
            {TREND_SERIES.map((s) => (
              <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[4, 4, 0, 0]} maxBarSize={18} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="grid h-40 place-items-center rounded-control border border-dashed border-line text-sm text-faint">{children}</div>;
}
