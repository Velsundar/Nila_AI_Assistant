/**
 * Startup data migrations. Each one is idempotent: a second run finds nothing to change.
 */
import { LEGACY_CATEGORIES } from "@nova/shared";
import { ExpenseModel } from "../models/Expense";
import { BudgetModel } from "../models/Budget";

export type CategoryMigrationResult = { expenses: number; budgetsRenamed: number; budgetsDropped: number };

/**
 * v5 renamed Transport → Transportation and Entertainment → Life & Entertainment. Runs on the raw
 * collections, so the (new) enum validators don't get in the way. Budgets are unique per
 * (userId, category): when a user already has a budget under the new name, that one wins and the
 * legacy one is deleted.
 */
export async function migrateLegacyCategories(): Promise<CategoryMigrationResult> {
  const out: CategoryMigrationResult = { expenses: 0, budgetsRenamed: 0, budgetsDropped: 0 };
  for (const [legacy, current] of Object.entries(LEGACY_CATEGORIES)) {
    const e = await ExpenseModel.collection.updateMany({ category: legacy }, { $set: { category: current } });
    out.expenses += e.modifiedCount;

    const old = await BudgetModel.collection.find({ category: legacy }, { projection: { _id: 1, userId: 1 } }).toArray();
    for (const b of old) {
      const clash = await BudgetModel.collection.findOne({ userId: b.userId, category: current }, { projection: { _id: 1 } });
      if (!clash) {
        try {
          const u = await BudgetModel.collection.updateOne({ _id: b._id }, { $set: { category: current } });
          out.budgetsRenamed += u.modifiedCount;
          continue;
        } catch (err) {
          // A budget under the new name was created in between: fall through and drop the legacy one.
          if ((err as { code?: number }).code !== 11000) throw err;
        }
      }
      const d = await BudgetModel.collection.deleteOne({ _id: b._id });
      out.budgetsDropped += d.deletedCount;
    }
  }
  return out;
}
