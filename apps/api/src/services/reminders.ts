import { Types, isValidObjectId } from "mongoose";
import type { Reminder } from "@nova/shared";
import { ReminderModel } from "../models/Reminder";
import { notFound } from "../errors";
import { toReminder } from "./serialize";

const oid = (id: string) => new Types.ObjectId(id);

export async function createReminder(userId: string, text: string, dateTime: string): Promise<Reminder> {
  const doc = await ReminderModel.create({ userId: oid(userId), text: text.trim(), dateTime: new Date(dateTime) });
  return toReminder(doc);
}

/** Pending reminders first (soonest first), then completed ones. */
export async function listReminders(userId: string, opts: { onlyPending?: boolean; limit?: number } = {}): Promise<Reminder[]> {
  const filter: Record<string, unknown> = { userId: oid(userId) };
  if (opts.onlyPending) filter.done = false;
  const docs = await ReminderModel.find(filter)
    .sort({ done: 1, dateTime: 1 })
    .limit(opts.limit ?? 500)
    .lean();
  return docs.map(toReminder);
}

export async function setReminderDone(userId: string, id: string, done: boolean): Promise<Reminder> {
  if (!isValidObjectId(id)) throw notFound("Reminder");
  const doc = await ReminderModel.findOneAndUpdate({ _id: id, userId: oid(userId) }, { $set: { done } }, { new: true }).lean();
  if (!doc) throw notFound("Reminder");
  return toReminder(doc);
}

export async function deleteReminder(userId: string, id: string): Promise<void> {
  if (!isValidObjectId(id)) throw notFound("Reminder");
  const r = await ReminderModel.deleteOne({ _id: id, userId: oid(userId) });
  if (!r.deletedCount) throw notFound("Reminder");
}
