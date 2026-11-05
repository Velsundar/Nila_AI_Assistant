/**
 * Money in and out together, oldest first, with a running balance that resets each pay cycle.
 */
import { Types } from "mongoose";
import type { Category, Ledger, LedgerEntry, LedgerPeriod } from "@nova/shared";
import { categoryGroup, LEGACY_CATEGORIES } from "@nova/shared";
import { ExpenseModel } from "../models/Expense";
import { IncomeModel } from "../models/Income";
import { HttpError } from "../errors";
import { localDateString, monthBounds, startOfDay, zonedToUtc } from "./dates";

const oid = (id: string) => new Types.ObjectId(id);

/** A salary older than this no longer starts the cycle (missed or irregular pay). */
export const SALARY_CYCLE_DAYS = 45;
/** Entries returned (the newest ones); totals and balances always cover the whole period. */
export const LEDGER_MAX_ENTRIES = 500;

const paise = (n: number) => Math.round(n * 100);
const rupees = (p: number) => p / 100;

/** `end` is exclusive: now + 1 ms for a salary cycle, the next month's start for a month. */
export type ResolvedPeriod = { period: LedgerPeriod; start: Date; end: Date };

/**
 * cycle: from the start of the day of the latest Salary income (within 45 days) up to now;
 * otherwise the current calendar month. month: that calendar month ("YYYY-MM", default this one).
 */
export async function resolveLedgerPeriod(
  userId: string,
  q: { period?: "cycle" | "month"; month?: string },
  tz: string,
  now = new Date(),
): Promise<ResolvedPeriod> {
  if (q.period === "month") {
    if (!q.month) {
      const { start, end } = monthBounds(now, tz);
      return { period: "month", start, end };
    }
    const [y, m] = q.month.split("-").map(Number);
    if (!(m >= 1 && m <= 12)) throw new HttpError(400, "VALIDATION_ERROR", "month must be YYYY-MM", { fieldErrors: { month: ["Invalid month"] } });
    return { period: "month", start: zonedToUtc(y, m, 1, 0, 0, 0, tz), end: zonedToUtc(y, m + 1, 1, 0, 0, 0, tz) };
  }
  const salary = await IncomeModel.findOne({
    userId: oid(userId),
    category: "Salary",
    date: { $gte: new Date(now.getTime() - SALARY_CYCLE_DAYS * 86_400_000), $lte: now },
  })
    .sort({ date: -1 })
    .select({ date: 1 })
    .lean();
  if (salary) return { period: "salary-cycle", start: startOfDay(localDateString(salary.date, tz), tz), end: new Date(now.getTime() + 1) };
  const { start, end } = monthBounds(now, tz);
  return { period: "month", start, end };
}

export async function getLedger(userId: string, q: { period?: "cycle" | "month"; month?: string }, tz: string, now = new Date()): Promise<Ledger> {
  const { period, start, end } = await resolveLedgerPeriod(userId, q, tz, now);
  const range = { userId: oid(userId), date: { $gte: start, $lt: end } };
  const [inc, exp] = await Promise.all([
    IncomeModel.find(range).sort({ date: 1, createdAt: 1 }).select({ amount: 1, category: 1, payer: 1, note: 1, date: 1 }).lean(),
    ExpenseModel.find(range)
      .sort({ date: 1, createdAt: 1 })
      .select({ amount: 1, category: 1, subcategory: 1, merchant: 1, note: 1, date: 1 })
      .lean(),
  ]);

  type Row = Omit<LedgerEntry, "balance"> & { t: number; p: number; saving?: boolean };
  const rows: Row[] = [
    ...inc.map((i) => ({
      kind: "income" as const,
      id: i._id.toString(),
      date: i.date.toISOString(),
      amount: i.amount,
      label: i.payer || i.note || i.category || "Income",
      category: i.category || "Other",
      t: i.date.getTime(),
      p: paise(i.amount),
    })),
    ...exp.map((e) => {
      const category = (LEGACY_CATEGORIES[e.category] ?? e.category) as Category;
      return {
        kind: "expense" as const,
        id: e._id.toString(),
        date: e.date.toISOString(),
        amount: -e.amount,
        label: e.merchant || e.note || e.subcategory || category,
        category,
        ...(e.subcategory ? { subcategory: e.subcategory } : {}),
        t: e.date.getTime(),
        p: -paise(e.amount),
        saving: categoryGroup(category) === "saving",
      };
    }),
  ];
  // Oldest first; on a tie, money in before money out (stable sort keeps each list's own order).
  rows.sort((a, b) => a.t - b.t || (a.kind === b.kind ? 0 : a.kind === "income" ? -1 : 1));

  let balance = 0;
  let received = 0;
  let spent = 0;
  let invested = 0;
  const entries: LedgerEntry[] = rows.map(({ t: _t, p, saving, ...entry }) => {
    balance += p;
    if (p > 0) received += p;
    else if (saving) invested -= p;
    else spent -= p;
    return { ...entry, balance: rupees(balance) };
  });

  return {
    period,
    from: start.toISOString(),
    to: new Date(end.getTime() - 1).toISOString(),
    entries: entries.slice(-LEDGER_MAX_ENTRIES),
    totals: { received: rupees(received), spent: rupees(spent), invested: rupees(invested), balance: rupees(received - spent - invested) },
  };
}
