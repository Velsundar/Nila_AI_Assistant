import { Schema, model } from "mongoose";

/** Per-user, per-UTC-day count of paid-tier-relevant provider calls (LLM, vision, Whisper). */
const usageSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  day: { type: String, required: true }, // YYYY-MM-DD (UTC)
  calls: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true },
});
usageSchema.index({ userId: 1, day: 1 }, { unique: true });
usageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const UsageModel = model("Usage", usageSchema);
