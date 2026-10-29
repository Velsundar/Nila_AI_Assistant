import { Router } from "express";
import { CategorySchema, UpsertBudgetSchema } from "@nova/shared";
import { ah, notFound, parse } from "../errors";
import { reqTimezone, uid } from "../middleware/auth";
import * as svc from "../services/budgets";

export const budgetsRouter = Router();

budgetsRouter.get(
  "/",
  ah(async (req, res) => {
    res.json({ budgets: await svc.listBudgets(uid(req), reqTimezone(req)) });
  }),
);

budgetsRouter.put(
  "/",
  ah(async (req, res) => {
    const input = parse(UpsertBudgetSchema, req.body);
    res.json({ budget: await svc.upsertBudget(uid(req), input.category, input.monthlyLimit, reqTimezone(req)) });
  }),
);

budgetsRouter.delete(
  "/:category",
  ah(async (req, res) => {
    const cat = CategorySchema.safeParse(req.params.category);
    if (!cat.success) throw notFound("Budget");
    await svc.deleteBudget(uid(req), cat.data);
    res.status(204).end();
  }),
);
