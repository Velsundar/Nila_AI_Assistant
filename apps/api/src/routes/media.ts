import { Router } from "express";
import { ScanReceiptSchema, TranscribeSchema } from "@nova/shared";
import { ah, parse } from "../errors";
import { reqTimezone, uid } from "../middleware/auth";
import { consumeDailyLlmCallOr429 } from "../services/usage";
import { scanReceipt } from "../services/receipts";
import { transcribe } from "../services/transcribe";

/** POST /api/receipts/scan — returns a draft only; nothing is saved. */
export const receiptsRouter = Router();
receiptsRouter.post(
  "/scan",
  ah(async (req, res) => {
    const { image } = parse(ScanReceiptSchema, req.body);
    const userId = uid(req);
    res.json(await scanReceipt(image, reqTimezone(req), { consumeBudget: () => consumeDailyLlmCallOr429(userId) }));
  }),
);

/** POST /api/transcribe — Groq Whisper; 503 STT_UNAVAILABLE without a key. */
export const transcribeRouter = Router();
transcribeRouter.post(
  "/",
  ah(async (req, res) => {
    const { audio, language } = parse(TranscribeSchema, req.body);
    const userId = uid(req);
    res.json(await transcribe(audio, language, { consumeBudget: () => consumeDailyLlmCallOr429(userId) }));
  }),
);
