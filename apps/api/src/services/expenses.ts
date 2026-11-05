import { Types, isValidObjectId } from "mongoose";
import type { Category, CreateExpenseInput, Expense, SpendingSummary, UpdateExpenseInput } from "@nova/shared";
import { CATEGORIES, SUBCATEGORIES } from "@nova/shared";
import { ExpenseModel } from "../models/Expense";
import { notFound } from "../errors";
import { parseExpenseDate, resolveRange, resolveTimezone } from "./dates";
import { HttpError } from "../errors";
import { round2, toExpense } from "./serialize";
import { classifyExpense, snapSubcategory } from "./categories";

const oid = (id: string) => new Types.ObjectId(id);

/** Round to paise and reject anything that rounds to zero (e.g. 0.004). */
export function money2(n: number, field = "amount"): number {
  const v = round2(n);
  if (!(v >= 0.01)) throw new HttpError(400, "VALIDATION_ERROR", `${field} must be at least 0.01`, { fieldErrors: { [field]: ["Must be at least 0.01"] } });
  return v;
}

/** `category` may be omitted (or "Other"): it is then inferred from merchant/note, like the subcategory. */
export async function createExpense(
  userId: string,
  input: Omit<CreateExpenseInput, "category"> & { category?: Category },
  tz: string,
): Promise<Expense> {
  const merchant = input.merchant?.trim() || undefined;
  const c = classifyExpense({ category: input.category, subcategory: input.subcategory, merchant, note: input.note });
  const doc = await ExpenseModel.create({
    userId: oid(userId),
    amount: money2(input.amount),
    category: c.category,
    subcategory: c.subcategory,
    merchant,
    note: (c.note ?? input.note)?.trim() || undefined,
    date: parseExpenseDate(input.date, tz),
    source: input.source ?? "manual",
  });
  return toExpense(doc);
}

export async function listExpenses(
  userId: string,
  q: { from?: string; to?: string; category?: Category; limit?: number },
  tz: string,
): Promise<Expense[]> {
  const filter: Record<string, unknown> = { userId: oid(userId) };
  if (q.from || q.to) {
    // Only bound the side(s) the caller asked for.
    const { start, end } = resolveRange(q.from, q.to, tz);
    const date: Record<string, Date> = {};
    if (q.from) date.$gte = start;
    if (q.to) date.$lt = end;
    filter.date = date;
  }
  if (q.category) filter.category = q.category;
  const docs = await ExpenseModel.find(filter)
    .sort({ date: -1, createdAt: -1 })
    .limit(q.limit ?? 100)
    .lean();
  return docs.map(toExpense);
}

export async function getExpense(userId: string, id: string): Promise<Expense> {
  if (!isValidObjectId(id)) throw notFound("Expense");
  const doc = await ExpenseModel.findOne({ _id: id, userId: oid(userId) }).lean();
  if (!doc) throw notFound("Expense");
  return toExpense(doc);
}

export async function updateExpense(userId: string, id: string, input: UpdateExpenseInput, tz: string): Promise<Expense> {
  if (!isValidObjectId(id)) throw notFound("Expense");
  const set: Record<string, unknown> = {};
  const unset: Record<string, 1> = {};
  if (input.amount !== undefined) set.amount = money2(input.amount);
  if (input.category !== undefined) set.category = input.category;
  if (input.source !== undefined) set.source = input.source;
  if (input.date !== undefined) set.date = parseExpenseDate(input.date, tz);
  if (input.subcategory !== undefined || input.category !== undefined) {
    // Subcategories belong to a category: snap a new one to it, and re-infer (or drop) the old one
    // when only the category changes.
    const cur = await ExpenseModel.findOne({ _id: id, userId: oid(userId) }).lean();
    if (!cur) throw notFound("Expense");
    const cat = (input.category ?? cur.category) as Category;
    if (input.subcategory !== undefined) {
      const sub = input.subcategory.trim() ? snapSubcategory(cat, input.subcategory) : undefined;
      if (sub) set.subcategory = sub;
      else unset.subcategory = 1;
    } else if (cat !== cur.category) {
      const keep = cur.subcategory && snapSubcategory(cat, cur.subcategory);
      const sub =
        keep && SUBCATEGORIES[cat].includes(keep)
          ? keep
          : classifyExpense({ category: cat, merchant: input.merchant ?? cur.merchant ?? undefined, note: input.note ?? cur.note ?? undefined }).subcategory;
      if (sub) set.subcategory = sub;
      else unset.subcategory = 1;
    }
  }
  for (const k of ["merchant", "note"] as const) {
    if (input[k] !== undefined) {
      const v = input[k]?.trim();
      if (v) set[k] = v;
      else unset[k] = 1;
    }
  }
  const doc = await ExpenseModel.findOneAndUpdate(
    { _id: id, userId: oid(userId) },
    { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) },
    { new: true },
  ).lean();
  if (!doc) throw notFound("Expense");
  return toExpense(doc);
}

export async function deleteExpense(userId: string, id: string): Promise<Expense> {
  if (!isValidObjectId(id)) throw notFound("Expense");
  const doc = await ExpenseModel.findOneAndDelete({ _id: id, userId: oid(userId) }).lean();
  if (!doc) throw notFound("Expense");
  return toExpense(doc);
}

export async function latestExpense(userId: string): Promise<Expense | null> {
  const doc = await ExpenseModel.findOne({ userId: oid(userId) }).sort({ createdAt: -1 }).lean();
  return doc ? toExpense(doc) : null;
}

/** Spending summary via a single MongoDB aggregation ($facet). Defaults to current calendar month in tz. */
export async function getSummary(
  userId: string,
  q: { from?: string; to?: string; category?: Category },
  tz: string,
): Promise<SpendingSummary> {
  tz = resolveTimezone(tz); // canonical name only ever reaches Mongo
  const { start, end } = resolveRange(q.from, q.to, tz);
  const match: Record<string, unknown> = { userId: oid(userId), date: { $gte: start, $lt: end } };
  if (q.category) match.category = q.category;

  const [res] = await ExpenseModel.aggregate<{
    totals: { total: number; count: number }[];
    byCategory: { _id: string; total: number; count: number }[];
    byDay: { _id: string; total: number }[];
    bySubcategory?: { _id: string | null; total: number; count: number }[];
  }>([
    { $match: match },
    {
      $facet: {
        totals: [{ $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } }],
        byCategory: [
          { $group: { _id: "$category", total: { $sum: "$amount" }, count: { $sum: 1 } } },
          { $sort: { total: -1 } },
        ],
        byDay: [
          { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$date", timezone: tz } }, total: { $sum: "$amount" } } },
          { $sort: { _id: 1 } },
        ],
        ...(q.category
          ? {
              bySubcategory: [
                { $group: { _id: { $ifNull: ["$subcategory", "Other"] }, total: { $sum: "$amount" }, count: { $sum: 1 } } },
                { $sort: { total: -1, _id: 1 } },
              ],
            }
          : {}),
      },
    },
  ]);

  const totals = res?.totals[0];
  return {
    from: start.toISOString(),
    to: new Date(end.getTime() - 1).toISOString(),
    total: round2(totals?.total ?? 0),
    count: totals?.count ?? 0,
    byCategory: (res?.byCategory ?? [])
      .filter((c) => (CATEGORIES as readonly string[]).includes(c._id))
      .map((c) => ({ category: c._id as Category, total: round2(c.total), count: c.count })),
    byDay: (res?.byDay ?? []).map((d) => ({ date: d._id, total: round2(d.total) })),
    ...(q.category ? { bySubcategory: mergeSubcategories(res?.bySubcategory ?? []) } : {}),
  };
}

/** "" and missing both count as "Other"; merge them after the $group. */
function mergeSubcategories(rows: { _id: string | null; total: number; count: number }[]) {
  const m = new Map<string, { total: number; count: number }>();
  for (const r of rows) {
    const k = r._id?.trim() || "Other";
    const cur = m.get(k) ?? { total: 0, count: 0 };
    m.set(k, { total: cur.total + r.total, count: cur.count + r.count });
  }
  return [...m.entries()]
    .map(([subcategory, v]) => ({ subcategory, total: round2(v.total), count: v.count }))
    .sort((a, b) => b.total - a.total || a.subcategory.localeCompare(b.subcategory));
}
