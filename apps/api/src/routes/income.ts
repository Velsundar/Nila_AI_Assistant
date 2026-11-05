import { Router } from "express";
import { z } from "zod";
import { CreateIncomeSchema, IncomeCategorySchema, IncomeQuerySchema, UpdateIncomeSchema } from "@nova/shared";
import { ah, parse } from "../errors";
import { reqTimezone, uid } from "../middleware/auth";
import * as svc from "../services/income";

export const incomeRouter = Router();

const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "Invalid date");
const SummaryQuerySchema = z.object({ from: isoDate.optional(), to: isoDate.optional(), category: IncomeCategorySchema.optional() });

incomeRouter.get(
  "/",
  ah(async (req, res) => {
    const q = parse(IncomeQuerySchema, req.query);
    res.json({ income: await svc.listIncome(uid(req), q, reqTimezone(req)) });
  }),
);

incomeRouter.get(
  "/summary",
  ah(async (req, res) => {
    const q = parse(SummaryQuerySchema, req.query);
    res.json(await svc.getIncomeSummary(uid(req), q, reqTimezone(req)));
  }),
);

incomeRouter.post(
  "/",
  ah(async (req, res) => {
    const input = parse(CreateIncomeSchema, req.body);
    res.status(201).json({ income: await svc.createIncome(uid(req), input, reqTimezone(req)) });
  }),
);

incomeRouter.patch(
  "/:id",
  ah(async (req, res) => {
    // .partial() keeps the defaults; strip them unless the client actually sent them.
    const input = parse(UpdateIncomeSchema, req.body);
    const sent = req.body && typeof req.body === "object" ? req.body : {};
    if (!("source" in sent)) delete input.source;
    if (!("category" in sent)) delete input.category;
    res.json({ income: await svc.updateIncome(uid(req), req.params.id, input, reqTimezone(req)) });
  }),
);

incomeRouter.delete(
  "/:id",
  ah(async (req, res) => {
    await svc.deleteIncome(uid(req), req.params.id);
    res.status(204).end();
  }),
);
