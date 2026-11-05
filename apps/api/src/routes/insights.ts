import { Router } from "express";
import { z } from "zod";
import { TrendsQuerySchema } from "@nova/shared";
import { ah, parse } from "../errors";
import { reqTimezone, uid } from "../middleware/auth";
import { buildDailyBriefing, buildWeeklyReport } from "../services/insights";
import { getTrends } from "../services/trends";

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

/** Analysis endpoints under /api/insights. */
export const insightsRouter = Router();
insightsRouter.get(
  "/trends",
  ah(async (req, res) => {
    const q = parse(TrendsQuerySchema, req.query);
    res.json(await getTrends(uid(req), q, reqTimezone(req)));
  }),
);
