import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";
import { CATEGORIES } from "@nova/shared";

const expenseSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    amount: { type: Number, required: true, min: 0 },
    category: { type: String, enum: CATEGORIES, required: true },
    merchant: { type: String, trim: true },
    note: { type: String, trim: true },
    date: { type: Date, required: true },
    source: { type: String, enum: ["voice", "manual", "receipt"], default: "manual" },
  },
  { timestamps: true },
);
// Covers userId-only and userId+date queries; single-field userId/date indexes would be redundant.
expenseSchema.index({ userId: 1, date: -1 });

export type ExpenseDoc = HydratedDocument<InferSchemaType<typeof expenseSchema>>;
export const ExpenseModel = model("Expense", expenseSchema);
