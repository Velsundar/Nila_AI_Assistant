/**
 * Month-by-month received / spent / invested / saved, from one aggregation per collection grouped
 * by month in the user's timezone. No LLM tokens.
 */
import { Types } from "mongoose";
import type { Category, MonthTrend, TrendsResult } from "@nova/shared";
import { CATEGORIES, categoryGroup, LEGACY_CATEGORIES } from "@nova/shared";
import { ExpenseModel } from "../models/Expense";
import { IncomeModel } from "../models/Income";
import { pad, resolveTimezone, zonedParts, zonedToUtc } from "./dates";
import { round2 } from "./serialize";

const oid = (id: string) => new Types.ObjectId(id);

/** One decimal, like the weekly report; null without a baseline. */
const changePct = (cur: number, prev: number) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);

export async function getTrends(userId: string, q: { months?: number }, tz: string, now = new Date()): Promise<TrendsResult> {
  tz = resolveTimezone(tz);
  const n = Math.min(12, Math.max(2, q.months ?? 6));
  const p = zonedParts(now, tz);
  const start = zonedToUtc(p.year, p.month - (n - 1), 1, 0, 0, 0, tz);
  const end = zonedToUtc(p.year, p.month + 1, 1, 0, 0, 0, tz);
  const keys: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(p.year, p.month - 1 - i, 1));
    keys.push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`);
  }

  const match = { userId: oid(userId), date: { $gte: start, $lt: end } };
  const month = { $dateToString: { format: "%Y-%m", date: "$date", timezone: tz } };
  const [exp, inc] = await Promise.all([
    ExpenseModel.aggregate<{ _id: { m: string; c: string }; total: number }>([
      { $match: match },
      { $group: { _id: { m: month, c: "$category" }, total: { $sum: "$amount" } } },
    ]),
    IncomeModel.aggregate<{ _id: string; total: number }>([{ $match: match }, { $group: { _id: month, total: { $sum: "$amount" } } }]),
  ]);

  const byMonth = new Map(keys.map((k) => [k, { received: 0, spent: 0, invested: 0, cats: new Map<Category, number>() }]));
  for (const r of inc) {
    const m = byMonth.get(r._id);
    if (m) m.received += r.total;
  }
  for (const r of exp) {
    const m = byMonth.get(r._id.m);
    const c = (LEGACY_CATEGORIES[r._id.c] ?? r._id.c) as Category;
    if (!m || !(CATEGORIES as readonly string[]).includes(c)) continue;
    if (categoryGroup(c) === "saving") m.invested += r.total;
    else {
      m.spent += r.total;
      m.cats.set(c, (m.cats.get(c) ?? 0) + r.total);
    }
  }

  const months: MonthTrend[] = keys.map((k) => {
    const m = byMonth.get(k)!;
    const received = round2(m.received);
    const spent = round2(m.spent);
    const saved = round2(received - spent);
    return {
      month: k,
      received,
      spent,
      invested: round2(m.invested),
      saved,
      savingsRate: received > 0 ? Math.round((saved / received) * 100) : null,
      topCategories: [...m.cats.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([category, total]) => ({ category, total: round2(total) })),
    };
  });

  const cur = byMonth.get(keys[n - 1]!)!;
  const prev = byMonth.get(keys[n - 2]!)!;
  const cats = new Set([...cur.cats.keys(), ...prev.cats.keys()]);
  const categoryChanges = [...cats]
    .map((category) => {
      const thisMonth = round2(cur.cats.get(category) ?? 0);
      const lastMonth = round2(prev.cats.get(category) ?? 0);
      return { category, thisMonth, lastMonth, changePercent: changePct(thisMonth, lastMonth) };
    })
    .sort((a, b) => Math.abs(b.thisMonth - b.lastMonth) - Math.abs(a.thisMonth - a.lastMonth))
    .slice(0, 5);

  // Complete months only (not the current one), from the first month with any activity, so a new
  // account's empty early months don't drag the average down.
  const complete = months.slice(0, -1);
  const first = complete.findIndex((m) => m.received > 0 || m.spent > 0 || m.invested > 0);
  const active = first < 0 ? [] : complete.slice(first);
  const averageMonthlySpent = active.length ? round2(active.reduce((s, m) => s + m.spent, 0) / active.length) : 0;

  return {
    months,
    spentChangePercent: changePct(months[n - 1]!.spent, months[n - 2]!.spent),
    categoryChanges,
    averageMonthlySpent,
  };
}
