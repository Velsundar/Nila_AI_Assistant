import type { Category, Expense, Income, IncomeCategory, Note, Reminder, Task, TaskPriority, User, ExpenseSource } from "@nova/shared";
import { ASSISTANT_NAME, DEFAULT_CURRENCY } from "@nova/shared";

type Id = { toString(): string };
const iso = (d: Date | string | undefined | null) => (d ? new Date(d).toISOString() : new Date(0).toISOString());

export function toUser(u: {
  _id: Id;
  name: string;
  email: string;
  currency?: string | null;
  assistantName?: string | null;
  city?: string | null;
  createdAt?: Date | null;
}): User {
  return {
    id: u._id.toString(),
    name: u.name,
    email: u.email,
    currency: u.currency || DEFAULT_CURRENCY,
    assistantName: u.assistantName || ASSISTANT_NAME,
    ...(u.city ? { city: u.city } : {}),
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

export function toTask(t: {
  _id: Id;
  title: string;
  list: string;
  dueDate?: Date | null;
  priority?: string | null;
  done?: boolean | null;
  completedAt?: Date | null;
  createdAt?: Date | null;
}): Task {
  return {
    id: t._id.toString(),
    title: t.title,
    list: t.list,
    ...(t.dueDate ? { dueDate: iso(t.dueDate) } : {}),
    priority: (t.priority || "normal") as TaskPriority,
    done: !!t.done,
    ...(t.completedAt ? { completedAt: iso(t.completedAt) } : {}),
    createdAt: iso(t.createdAt),
  };
}

export function toNote(n: { _id: Id; text: string; createdAt?: Date | null; updatedAt?: Date | null }): Note {
  return { id: n._id.toString(), text: n.text, createdAt: iso(n.createdAt), updatedAt: iso(n.updatedAt ?? n.createdAt) };
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

export function toIncome(i: {
  _id: Id;
  amount: number;
  category?: string | null;
  payer?: string | null;
  note?: string | null;
  date: Date;
  source?: string | null;
  createdAt?: Date | null;
}): Income {
  return {
    id: i._id.toString(),
    amount: i.amount,
    category: (i.category || "Other") as IncomeCategory,
    ...(i.payer ? { payer: i.payer } : {}),
    ...(i.note ? { note: i.note } : {}),
    date: iso(i.date),
    source: (i.source || "manual") as ExpenseSource,
    createdAt: iso(i.createdAt),
  };
}
