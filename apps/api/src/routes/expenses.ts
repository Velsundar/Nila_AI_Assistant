import { Router } from "express";
import { z } from "zod";
import { CategorySchema, CreateExpenseSchema, ExpenseQuerySchema, UpdateExpenseSchema } from "@nova/shared";
import { ah, parse } from "../errors";
import { reqTimezone, uid } from "../middleware/auth";
import * as svc from "../services/expenses";
import { withCurrentCategory } from "../services/categories";

export const expensesRouter = Router();

const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "Invalid date");
const SummaryQuerySchema = z.object({ from: isoDate.optional(), to: isoDate.optional(), category: CategorySchema.optional() });

expensesRouter.get(
  "/",
  ah(async (req, res) => {
    const q = parse(ExpenseQuerySchema, withCurrentCategory(req.query));
    res.json({ expenses: await svc.listExpenses(uid(req), q, reqTimezone(req)) });
  }),
);

expensesRouter.get(
  "/summary",
  ah(async (req, res) => {
    const q = parse(SummaryQuerySchema, withCurrentCategory(req.query));
    res.json(await svc.getSummary(uid(req), q, reqTimezone(req)));
  }),
);

expensesRouter.post(
  "/",
  ah(async (req, res) => {
    const input = parse(CreateExpenseSchema, withCurrentCategory(req.body));
    res.status(201).json({ expense: await svc.createExpense(uid(req), input, reqTimezone(req)) });
  }),
);

expensesRouter.get(
  "/:id",
  ah(async (req, res) => {
    res.json({ expense: await svc.getExpense(uid(req), req.params.id) });
  }),
);

expensesRouter.patch(
  "/:id",
  ah(async (req, res) => {
    // .partial() keeps the `source` default; strip it unless the client actually sent it.
    const input = parse(UpdateExpenseSchema, withCurrentCategory(req.body));
    if (!req.body || typeof req.body !== "object" || !("source" in req.body)) delete input.source;
    res.json({ expense: await svc.updateExpense(uid(req), req.params.id, input, reqTimezone(req)) });
  }),
);

expensesRouter.delete(
  "/:id",
  ah(async (req, res) => {
    await svc.deleteExpense(uid(req), req.params.id);
    res.status(204).end();
  }),
);
