import { Router } from "express";
import { z } from "zod";
import { ah, parse } from "../errors";
import { reqTimezone, uid } from "../middleware/auth";
import { buildDailyBriefing, buildWeeklyReport } from "../services/insights";

export const briefingRouter = Router();
briefingRouter.get(
  "/",
  ah(async (req, res) => {
    res.json(await buildDailyBriefing(req.user!, reqTimezone(req)));
  }),
);

export const reportsRouter = Router();
reportsRouter.get(
  "/weekly",
  ah(async (req, res) => {
    const { weekStart } = parse(z.object({ weekStart: z.string().optional() }), req.query);
    res.json(await buildWeeklyReport(uid(req), { weekStart, currency: req.user!.currency }, reqTimezone(req)));
  }),
);
