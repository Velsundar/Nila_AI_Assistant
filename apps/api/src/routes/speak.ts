import { Router } from "express";
import { SpeakSchema } from "@nova/shared";
import { ah, parse } from "../errors";
import { uid } from "../middleware/auth";
import { consumeDailyTtsCallOr429 } from "../services/usage";
import { getNaturalVoices, speak } from "../services/speech";

/** Natural voice (Groq Orpheus). GET /voices always 200; POST / -> 503 TTS_UNAVAILABLE when unusable. */
export const speakRouter = Router();

speakRouter.get(
  "/voices",
  ah(async (_req, res) => {
    res.json(await getNaturalVoices());
  }),
);

speakRouter.post(
  "/",
  ah(async (req, res) => {
    const input = parse(SpeakSchema, req.body);
    const userId = uid(req);
    res.json(await speak(input, { consumeBudget: () => consumeDailyTtsCallOr429(userId) }));
  }),
);
