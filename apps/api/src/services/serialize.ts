import type { Category, Expense, Reminder, User, ExpenseSource } from "@nova/shared";
import { ASSISTANT_NAME, DEFAULT_CURRENCY } from "@nova/shared";

type Id = { toString(): string };
const iso = (d: Date | string | undefined | null) => (d ? new Date(d).toISOString() : new Date(0).toISOString());

export function toUser(u: {
  _id: Id;
  name: string;
  email: string;
  currency?: string | null;
  assistantName?: string | null;
  createdAt?: Date | null;
}): User {
  return {
    id: u._id.toString(),
    name: u.name,
    email: u.email,
    currency: u.currency || DEFAULT_CURRENCY,
    assistantName: u.assistantName || ASSISTANT_NAME,
    createdAt: iso(u.createdAt),
  };
}

export function toExpense(e: {
  _id: Id;
  amount: number;
  category: string;
  merchant?: string | null;
  note?: string | null;
  date: Date;
  source?: string | null;
  createdAt?: Date | null;
}): Expense {
  return {
    id: e._id.toString(),
    amount: e.amount,
    category: e.category as Category,
    ...(e.merchant ? { merchant: e.merchant } : {}),
    ...(e.note ? { note: e.note } : {}),
    date: iso(e.date),
    source: (e.source || "manual") as ExpenseSource,
    createdAt: iso(e.createdAt),
  };
}

export function toReminder(r: { _id: Id; text: string; dateTime: Date; done?: boolean | null; createdAt?: Date | null }): Reminder {
  return {
    id: r._id.toString(),
    text: r.text,
    dateTime: iso(r.dateTime),
    done: !!r.done,
    createdAt: iso(r.createdAt),
  };
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
