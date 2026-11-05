import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";
import { INCOME_CATEGORIES } from "@nova/shared";

/** Money received. A separate collection, so spending totals and budgets never include it. */
const incomeSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    amount: { type: Number, required: true, min: 0 },
    category: { type: String, enum: INCOME_CATEGORIES, required: true, default: "Other" },
    payer: { type: String, trim: true },
    note: { type: String, trim: true },
    date: { type: Date, required: true },
    source: { type: String, enum: ["voice", "manual", "receipt"], default: "manual" },
  },
  { timestamps: true },
);
incomeSchema.index({ userId: 1, date: -1 });

export type IncomeDoc = HydratedDocument<InferSchemaType<typeof incomeSchema>>;
export const IncomeModel = model("Income", incomeSchema);
