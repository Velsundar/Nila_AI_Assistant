import { Types } from "mongoose";
import type { BudgetStatus, Category } from "@nova/shared";
import { BudgetModel } from "../models/Budget";
import { ExpenseModel } from "../models/Expense";
import { notFound } from "../errors";
import { monthBounds } from "./dates";
import { round2 } from "./serialize";

const oid = (id: string) => new Types.ObjectId(id);

/** Current-month spend per category, computed with a MongoDB aggregation. */
async function monthSpendByCategory(userId: string, tz: string, categories?: Category[]): Promise<Map<string, number>> {
  const { start, end } = monthBounds(new Date(), tz);
  const match: Record<string, unknown> = { userId: oid(userId), date: { $gte: start, $lt: end } };
  if (categories) match.category = { $in: categories };
  const rows = await ExpenseModel.aggregate<{ _id: string; spent: number }>([
    { $match: match },
    { $group: { _id: "$category", spent: { $sum: "$amount" } } },
  ]);
  return new Map(rows.map((r) => [r._id, r.spent]));
}

function status(category: Category, monthlyLimit: number, spent: number): BudgetStatus {
  const s = round2(spent);
  return {
    category,
    monthlyLimit,
    spent: s,
    percentUsed: monthlyLimit > 0 ? Math.round((s / monthlyLimit) * 1000) / 10 : 0,
  };
}

export async function listBudgets(userId: string, tz: string): Promise<BudgetStatus[]> {
  const budgets = await BudgetModel.find({ userId: oid(userId) }).sort({ category: 1 }).lean();
  if (!budgets.length) return [];
  const spend = await monthSpendByCategory(userId, tz, budgets.map((b) => b.category as Category));
  return budgets.map((b) => status(b.category as Category, b.monthlyLimit, spend.get(b.category) ?? 0));
}

export async function getBudgetStatus(userId: string, category: Category, tz: string): Promise<BudgetStatus | null> {
  const b = await BudgetModel.findOne({ userId: oid(userId), category }).lean();
  if (!b) return null;
  const spend = await monthSpendByCategory(userId, tz, [category]);
  return status(category, b.monthlyLimit, spend.get(category) ?? 0);
}

export async function upsertBudget(userId: string, category: Category, monthlyLimit: number, tz: string): Promise<BudgetStatus> {
  await BudgetModel.findOneAndUpdate(
    { userId: oid(userId), category },
    { $set: { monthlyLimit: round2(monthlyLimit) } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return (await getBudgetStatus(userId, category, tz))!;
}

export async function deleteBudget(userId: string, category: Category): Promise<void> {
  const r = await BudgetModel.deleteOne({ userId: oid(userId), category });
  if (!r.deletedCount) throw notFound("Budget");
}
