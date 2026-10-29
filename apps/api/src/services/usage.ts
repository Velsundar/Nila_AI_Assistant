import { Types } from "mongoose";
import { config } from "../config";
import { HttpError } from "../errors";
import { UsageModel } from "../models/Usage";

const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

export class BudgetExceededError extends Error {}

/**
 * Atomically count one provider call against the user's daily budget (UTC day).
 * Throws BudgetExceededError when the budget is used up; the counter never exceeds the limit.
 */
export async function consumeDailyLlmCall(userId: string, limit = config.llm.dailyCallLimit): Promise<number> {
  const day = utcDay();
  try {
    const doc = await UsageModel.findOneAndUpdate(
      { userId: new Types.ObjectId(userId), day, calls: { $lt: limit } },
      { $inc: { calls: 1 }, $setOnInsert: { expiresAt: new Date(Date.now() + 2 * 86_400_000) } },
      { upsert: true, new: true },
    ).lean();
    return doc!.calls;
  } catch (e) {
    // Filter failed on an existing doc (calls >= limit) -> upsert collides with the unique index.
    if ((e as { code?: number }).code === 11000) throw new BudgetExceededError("Daily assistant limit reached");
    throw e;
  }
}

/** REST variant: 429 DAILY_LIMIT. */
export async function consumeDailyLlmCallOr429(userId: string): Promise<void> {
  try {
    await consumeDailyLlmCall(userId);
  } catch (e) {
    if (e instanceof BudgetExceededError) {
      throw new HttpError(429, "DAILY_LIMIT", "You've reached today's limit for AI features. It resets at midnight UTC.");
    }
    throw e;
  }
}

export const DAILY_LIMIT_REPLY = "You've reached today's limit for assistant requests. It resets at midnight UTC.";
