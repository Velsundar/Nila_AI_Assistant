import { Types, isValidObjectId } from "mongoose";
import type { CreateIncomeInput, Income, IncomeCategory, IncomeSummary, UpdateIncomeInput } from "@nova/shared";
import { INCOME_CATEGORIES } from "@nova/shared";
import { IncomeModel } from "../models/Income";
import { notFound } from "../errors";
import { parseExpenseDate, resolveRange, resolveTimezone } from "./dates";
import { money2 } from "./expenses";
import { round2, toIncome } from "./serialize";

const oid = (id: string) => new Types.ObjectId(id);

export async function createIncome(userId: string, input: CreateIncomeInput, tz: string): Promise<Income> {
  const doc = await IncomeModel.create({
    userId: oid(userId),
    amount: money2(input.amount),
    category: input.category ?? "Other",
    payer: input.payer?.trim() || undefined,
    note: input.note?.trim() || undefined,
    date: parseExpenseDate(input.date, tz),
    source: input.source ?? "manual",
  });
  return toIncome(doc);
}

export async function listIncome(
  userId: string,
  q: { from?: string; to?: string; category?: IncomeCategory; limit?: number },
  tz: string,
): Promise<Income[]> {
  const filter: Record<string, unknown> = { userId: oid(userId) };
  if (q.from || q.to) {
    const { start, end } = resolveRange(q.from, q.to, tz);
    const date: Record<string, Date> = {};
    if (q.from) date.$gte = start;
    if (q.to) date.$lt = end;
    filter.date = date;
  }
  if (q.category) filter.category = q.category;
  const docs = await IncomeModel.find(filter)
    .sort({ date: -1, createdAt: -1 })
    .limit(q.limit ?? 100)
    .lean();
  return docs.map(toIncome);
}

export async function updateIncome(userId: string, id: string, input: UpdateIncomeInput, tz: string): Promise<Income> {
  if (!isValidObjectId(id)) throw notFound("Income");
  const set: Record<string, unknown> = {};
  const unset: Record<string, 1> = {};
  if (input.amount !== undefined) set.amount = money2(input.amount);
  if (input.category !== undefined) set.category = input.category;
  if (input.source !== undefined) set.source = input.source;
  if (input.date !== undefined) set.date = parseExpenseDate(input.date, tz);
  for (const k of ["payer", "note"] as const) {
    if (input[k] !== undefined) {
      const v = input[k]?.trim();
      if (v) set[k] = v;
      else unset[k] = 1;
    }
  }
  const doc = await IncomeModel.findOneAndUpdate(
    { _id: id, userId: oid(userId) },
    { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) },
    { new: true },
  ).lean();
  if (!doc) throw notFound("Income");
  return toIncome(doc);
}

export async function deleteIncome(userId: string, id: string): Promise<Income> {
  if (!isValidObjectId(id)) throw notFound("Income");
  const doc = await IncomeModel.findOneAndDelete({ _id: id, userId: oid(userId) }).lean();
  if (!doc) throw notFound("Income");
  return toIncome(doc);
}

/** Income totals for a range (default: current calendar month in tz). */
export async function getIncomeSummary(
  userId: string,
  q: { from?: string; to?: string; category?: IncomeCategory },
  tz: string,
): Promise<IncomeSummary> {
  tz = resolveTimezone(tz);
  const { start, end } = resolveRange(q.from, q.to, tz);
  const match: Record<string, unknown> = { userId: oid(userId), date: { $gte: start, $lt: end } };
  if (q.category) match.category = q.category;
  const rows = await IncomeModel.aggregate<{ _id: string; total: number; count: number }>([
    { $match: match },
    { $group: { _id: "$category", total: { $sum: "$amount" }, count: { $sum: 1 } } },
    { $sort: { total: -1 } },
  ]);
  const byCategory = rows
    .filter((r) => (INCOME_CATEGORIES as readonly string[]).includes(r._id))
    .map((r) => ({ category: r._id as IncomeCategory, total: round2(r.total), count: r.count }));
  return {
    from: start.toISOString(),
    to: new Date(end.getTime() - 1).toISOString(),
    total: round2(byCategory.reduce((s, c) => s + c.total, 0)),
    count: byCategory.reduce((s, c) => s + c.count, 0),
    byCategory,
  };
}
