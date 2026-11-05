import { Router } from "express";
import { LedgerQuerySchema } from "@nova/shared";
import { ah, parse } from "../errors";
import { reqTimezone, uid } from "../middleware/auth";
import { getLedger } from "../services/ledger";

export const ledgerRouter = Router();

ledgerRouter.get(
  "/",
  ah(async (req, res) => {
    const q = parse(LedgerQuerySchema, req.query);
    res.json(await getLedger(uid(req), q, reqTimezone(req)));
  }),
);
