import { Schema, model } from "mongoose";

/**
 * Per-user, per-UTC-day provider-call counters: `calls` (LLM, vision, Whisper) and `ttsCalls`
 * (natural voice), each with its own daily limit.
 */
const usageSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  day: { type: String, required: true }, // YYYY-MM-DD (UTC)
  calls: { type: Number, default: 0 },
  ttsCalls: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true },
});
usageSchema.index({ userId: 1, day: 1 }, { unique: true });
usageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const UsageModel = model("Usage", usageSchema);
