import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";
import { CATEGORIES } from "@nova/shared";

const budgetSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    category: { type: String, enum: CATEGORIES, required: true },
    monthlyLimit: { type: Number, required: true, min: 0 },
  },
  { timestamps: true },
);
budgetSchema.index({ userId: 1, category: 1 }, { unique: true });

export type BudgetDoc = HydratedDocument<InferSchemaType<typeof budgetSchema>>;
export const BudgetModel = model("Budget", budgetSchema);
