import { Types } from "mongoose";
import { config } from "../config";
import { HttpError } from "../errors";
import { UsageModel } from "../models/Usage";

const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

export class BudgetExceededError extends Error {}

/** Separate daily counters on the same Usage doc. */
export type UsageCounter = "calls" | "ttsCalls";

/**
 * Atomically count one call on `counter` against the user's daily budget (UTC day).
 * Throws BudgetExceededError when the budget is used up; the counter never exceeds the limit.
 */
async function consumeDaily(userId: string, counter: UsageCounter, limit: number): Promise<number> {
  const day = utcDay();
  try {
    const doc = await UsageModel.findOneAndUpdate(
      // Docs written before a counter existed lack the field; treat that as 0.
      { userId: new Types.ObjectId(userId), day, $or: [{ [counter]: { $lt: limit } }, { [counter]: { $exists: false } }] },
      { $inc: { [counter]: 1 }, $setOnInsert: { expiresAt: new Date(Date.now() + 2 * 86_400_000) } },
      { upsert: true, new: true },
    ).lean();
    return (doc as unknown as Record<UsageCounter, number>)[counter];
  } catch (e) {
    // Filter failed on an existing doc (counter >= limit) -> upsert collides with the unique index.
    if ((e as { code?: number }).code === 11000) throw new BudgetExceededError("Daily limit reached");
    throw e;
  }
}

export function consumeDailyLlmCall(userId: string, limit = config.llm.dailyCallLimit): Promise<number> {
  return consumeDaily(userId, "calls", limit);
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

/** Natural-voice budget (TTS_DAILY_CALL_LIMIT), independent of the LLM one. 429 DAILY_LIMIT. */
export async function consumeDailyTtsCallOr429(userId: string, limit = config.tts.dailyCallLimit): Promise<void> {
  try {
    await consumeDaily(userId, "ttsCalls", limit);
  } catch (e) {
    if (e instanceof BudgetExceededError) {
      throw new HttpError(429, "DAILY_LIMIT", "You've reached today's limit for the natural voice. It resets at midnight UTC.");
    }
    throw e;
  }
}

export const DAILY_LIMIT_REPLY = "You've reached today's limit for assistant requests. It resets at midnight UTC.";
