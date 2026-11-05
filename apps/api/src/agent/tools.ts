import { z, type ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { Types, isValidObjectId } from "mongoose";
import { CATEGORIES, type Category, type Expense } from "@nova/shared";
import { ExpenseModel } from "../models/Expense";
import { MemoryModel } from "../models/Memory";
import { BudgetModel } from "../models/Budget";
import * as expenses from "../services/expenses";
import * as budgets from "../services/budgets";
import * as reminders from "../services/reminders";
import * as tasks from "../services/tasks";
import * as notes from "../services/notes";
import { buildDailyBriefing, buildWeeklyReport } from "../services/insights";
import { geocodeCity, getForecast, WeatherError } from "../services/weather";
import { isDateOnly, localDateString, zonedToUtc } from "../services/dates";
import { toExpense } from "../services/serialize";
import { formatMoney, speakDay } from "./format";
import type { ToolDefinition } from "./llm";

export type ToolUser = {
  _id: { toString(): string };
  name: string;
  currency?: string | null;
  city?: string | null;
  cityLat?: number | null;
  cityLon?: number | null;
};

export type ToolContext = { userId: string; timezone: string; now: Date; currency: string; user?: ToolUser };

/** A tool failure that is reported back to the model (not a server error). */
export class ToolError extends Error {}

type Prepared = { args: Record<string, unknown>; summary: string };

export type Tool<S extends ZodTypeAny = ZodTypeAny> = {
  name: string;
  description: string;
  schema: S;
  /** Destructive tools are never run directly: prepare() resolves the target and returns a yes/no summary. */
  destructive?: boolean;
  /** Like `destructive`, but only for some calls (e.g. manageTask "delete", or setBudget overwriting a budget). */
  confirmIf?: (args: z.output<S>, ctx: ToolContext) => boolean | Promise<boolean>;
  /** Spoken reply after the user said yes and execute() succeeded. */
  confirmedReply?: (result: any, ctx: ToolContext) => string; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** Server-only args (filled in by prepare) hidden from the model's JSON schema. */
  hiddenArgs?: string[];
  prepare?: (args: z.output<S>, ctx: ToolContext) => Promise<Prepared>;
  execute: (args: z.output<S>, ctx: ToolContext) => Promise<unknown>;
};

// ---------- shared arg schemas ----------

const CATEGORY_ALIASES: Record<string, Category> = {
  grocery: "Groceries",
  transportation: "Transport",
  travelling: "Travel",
  bill: "Bills",
  utilities: "Bills",
  medical: "Health",
  fun: "Entertainment",
  shop: "Shopping",
  misc: "Other",
  miscellaneous: "Other",
  dining: "Food",
};

export function normalizeCategory(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const s = v.trim().toLowerCase();
  const hit = CATEGORIES.find((c) => c.toLowerCase() === s);
  return hit ?? CATEGORY_ALIASES[s] ?? v;
}

const category = z.preprocess(normalizeCategory, z.enum(CATEGORIES));
const dateStr = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), "Invalid date, use YYYY-MM-DD");
const money = z.coerce
  .number()
  .positive()
  .max(100_000_000)
  .refine((n) => Math.round(n * 100) / 100 >= 0.01, "Must be at least 0.01");
const matchSchema = z
  .object({
    merchant: z.string().optional(),
    amount: money.optional(),
  })
  .describe("Find hints; omit for the latest expense");

// ---------- helpers ----------

const oid = (id: string) => new Types.ObjectId(id);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function brief(e: Expense, tz: string) {
  return {
    id: e.id,
    amount: e.amount,
    category: e.category,
    ...(e.merchant ? { merchant: e.merchant } : {}),
    ...(e.note ? { note: e.note } : {}),
    date: localDateString(new Date(e.date), tz),
  };
}

export function describeExpense(e: { amount: number; merchant?: string; note?: string; category: string; date: string }, ctx: ToolContext) {
  const what = e.merchant ? `at ${e.merchant}` : e.note ? `for ${e.note}` : `on ${e.category}`;
  return `${formatMoney(e.amount, ctx.currency)} ${what} from ${speakDay(e.date, ctx.timezone, ctx.now)}`.replace(
    "from on ",
    "from ",
  );
}

async function findTarget(ctx: ToolContext, expenseId?: string, match?: { merchant?: string; amount?: number }): Promise<Expense> {
  if (expenseId) {
    if (!isValidObjectId(expenseId)) throw new ToolError("No expense with that id. Use listRecentExpenses to find it.");
    const doc = await ExpenseModel.findOne({ _id: expenseId, userId: oid(ctx.userId) }).lean();
    if (!doc) throw new ToolError("No expense with that id. Use listRecentExpenses to find it.");
    return toExpense(doc);
  }
  const filter: Record<string, unknown> = { userId: oid(ctx.userId) };
  if (match?.merchant) filter.merchant = new RegExp(`^${escapeRe(match.merchant.trim())}`, "i");
  if (match?.amount) filter.amount = match.amount;
  const doc = await ExpenseModel.findOne(filter).sort({ date: -1, createdAt: -1 }).lean();
  if (!doc) throw new ToolError(match?.merchant || match?.amount ? "No matching expense found." : "There are no expenses yet.");
  return toExpense(doc);
}

function budgetNote(b: { category: string; percentUsed: number } | null): string | undefined {
  if (!b) return undefined;
  if (b.percentUsed >= 100) return `Over budget: ${Math.round(b.percentUsed)}% of the ${b.category} budget used this month.`;
  if (b.percentUsed >= 80) return `Warning: ${Math.round(b.percentUsed)}% of the ${b.category} budget used this month.`;
  return undefined;
}

/** Date-only reminder times default to 9 AM local. */
function reminderDate(s: string, tz: string): Date {
  if (isDateOnly(s)) {
    const [y, m, d] = s.split("-").map(Number);
    return zonedToUtc(y, m, d, 9, 0, 0, tz);
  }
  // Naive "YYYY-MM-DDTHH:mm[:ss]" without offset = local wall time in the user's zone.
  const naive = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (naive) {
    const [, y, mo, d, h, mi, se] = naive.map(Number);
    return zonedToUtc(y, mo, d, h, mi, se || 0, tz);
  }
  return new Date(s);
}

// ---------- memory safety ----------

/** Tool names (filled below) — a "fact" that names a tool is an attempt to steer the agent. */
const TOOL_NAMES_LOWER: string[] = [];

/**
 * Memories go into every system prompt, so reject "facts" that read like instructions to the
 * assistant (prompt injection that would persist across conversations).
 */
export function looksLikeInstruction(fact: string): boolean {
  const t = fact.toLowerCase();
  if (TOOL_NAMES_LOWER.some((n) => t.includes(n))) return true;
  return [
    /\b(ignore|disregard|override|bypass|forget)\b[^.]*\b(instructions?|rules?|prompt|previous|above|guidelines?|confirm\w*)\b/,
    /\b(system prompt|developer message|jailbreak|act as|pretend (to be|you)|you are now|new instructions?)\b/,
    /\b(you|assistant|nila|nova)\s+(must|should|shall|will)\s+(always|never|now)?\s*(call|run|use|delete|remove|erase|execute|send|transfer|ignore|skip|stop asking)\b/,
    /\b(always|never|automatically)\s+(call|run|use|delete|remove|erase|execute|confirm|ask|say yes)\b/,
    /\b(without|skip(ping)?|no)\s+(asking|confirmation|confirming)\b/,
    /\b(delete|remove|erase|wipe)\s+(all|every(thing)?|my (entire|whole))\b/,
    /\b(tool|function)\s*(call|calls)\b/,
  ].some((re) => re.test(t));
}

async function findMemory(userId: string, q: string) {
  const all = await MemoryModel.find({ userId: oid(userId) }).sort({ createdAt: -1 }).limit(200).lean();
  const words = q.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !["that", "the", "about", "forget", "remember", "my"].includes(w));
  let best: { m: (typeof all)[number]; score: number } | undefined;
  for (const m of all) {
    const f = m.fact.toLowerCase();
    const score = f === q.toLowerCase().trim() ? 100 : words.filter((w) => f.includes(w)).length;
    if (score > 0 && (!best || score > best.score)) best = { m, score };
  }
  return best?.m;
}

// ---------- tools ----------

/** Typed at definition site, erased for the registry (function params are contravariant). */
function tool<S extends ZodTypeAny>(t: Tool<S>): Tool {
  return t as unknown as Tool;
}

const updateFields = z.object({
  amount: money.optional(),
  category: category.optional(),
  merchant: z.string().max(100).optional(),
  note: z.string().max(500).optional(),
  date: dateStr.optional(),
});

const ymdIn = (d: string | undefined, tz: string) => (d ? localDateString(new Date(d), tz) : undefined);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Models sometimes send `title: "x"` instead of `titles: ["x"]`. */
const titlesArg = z.preprocess(
  (v) => (typeof v === "string" ? v.split(/\s*,\s*|\s+and\s+/).filter(Boolean) : v),
  z.array(z.string().min(1).max(200)).max(25),
);
const taskSchema = z.preprocess(
  (v) => (v && typeof v === "object" && "title" in v && !("titles" in v) ? { ...(v as object), titles: (v as { title: unknown }).title } : v),
  z.object({
    action: z.enum(["add", "list", "complete", "delete"]),
    titles: titlesArg.optional().describe("One per item"),
    list: z.string().max(40).optional().describe("e.g. Shopping (default Inbox)"),
    dueDate: dateStr.optional(),
    priority: z.enum(["low", "normal", "high"]).optional(),
    when: z.enum(["today", "overdue"]).optional().describe("list filter"),
    ids: z.array(z.string()).optional(),
  }),
);

const joinWords = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

export const TOOLS: Tool[] = [
  tool({
    name: "addExpense",
    description: "Log money the user spent.",
    schema: z.object({
      amount: money,
      category: category,
      merchant: z.string().max(100).optional().describe("e.g. Swiggy"),
      note: z.string().max(500).optional().describe("e.g. lunch"),
      date: dateStr.optional().describe("Omit for today"),
    }),
    async execute(a, ctx) {
      const e = await expenses.createExpense(ctx.userId, { ...a, source: "voice" }, ctx.timezone);
      const budget = await budgets.getBudgetStatus(ctx.userId, e.category, ctx.timezone);
      const note = budgetNote(budget);
      return { expense: brief(e, ctx.timezone), budget, ...(note ? { budgetWarning: note } : {}) };
    },
  }),
  tool({
    name: "listRecentExpenses",
    description: "Recent expenses, newest first.",
    schema: z.object({
      limit: z.coerce.number().int().min(1).max(20).default(5),
      category: category.optional(),
      from: dateStr.optional(),
      to: dateStr.optional(),
    }),
    async execute(a, ctx) {
      const list = await expenses.listExpenses(ctx.userId, a, ctx.timezone);
      return { expenses: list.map((e) => brief(e, ctx.timezone)) };
    },
  }),
  tool({
    name: "getSpendingSummary",
    description: "Exact spending totals by category for a date range (default this month). Use for any total.",
    schema: z.object({
      from: dateStr.optional(),
      to: dateStr.optional(),
      category: category.optional(),
    }),
    async execute(a, ctx) {
      const s = await expenses.getSummary(ctx.userId, a, ctx.timezone);
      const budget = a.category ? await budgets.getBudgetStatus(ctx.userId, a.category, ctx.timezone) : null;
      return {
        from: localDateString(new Date(s.from), ctx.timezone),
        to: localDateString(new Date(s.to), ctx.timezone),
        ...(a.category ? { category: a.category } : {}),
        total: s.total,
        count: s.count,
        byCategory: s.byCategory,
        ...(budget ? { budget } : {}),
      };
    },
  }),
  tool({
    name: "updateExpense",
    description: "Change an expense. The user confirms automatically.",
    destructive: true,
    schema: updateFields.extend({
      expenseId: z.string().optional(),
      match: matchSchema.optional(),
    }),
    async prepare(a, ctx) {
      const { expenseId, match, ...changes } = a;
      const fields = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
      if (!Object.keys(fields).length) throw new ToolError("Nothing to change. Provide amount, category, merchant, note or date.");
      const target = await findTarget(ctx, expenseId, match);
      const parts: string[] = [];
      if (fields.amount !== undefined) parts.push(`the amount to ${formatMoney(fields.amount as number, ctx.currency)}`);
      if (fields.category) parts.push(`the category to ${fields.category}`);
      if (fields.merchant !== undefined) parts.push(`the merchant to ${fields.merchant}`);
      if (fields.note !== undefined) parts.push(`the note to ${fields.note}`);
      if (fields.date) parts.push(`the date to ${speakDay(String(fields.date), ctx.timezone, ctx.now).replace(/^on /, "")}`);
      return {
        args: { expenseId: target.id, ...fields },
        summary: `Change ${describeExpense(target, ctx)}, setting ${parts.join(" and ")}?`,
      };
    },
    async execute(a, ctx) {
      const { expenseId, match: _m, ...changes } = a;
      if (!expenseId) throw new ToolError("expenseId is required");
      try {
        const e = await expenses.updateExpense(ctx.userId, expenseId, changes, ctx.timezone);
        return { expense: brief(e, ctx.timezone) };
      } catch {
        throw new ToolError("That expense no longer exists.");
      }
    },
    confirmedReply: (r, ctx) =>
      `Done. It's now ${formatMoney(r.expense.amount, ctx.currency)} under ${r.expense.category}${r.expense.merchant ? ` at ${r.expense.merchant}` : ""}.`,
  }),
  tool({
    name: "deleteExpense",
    description: "Delete an expense. The user confirms automatically.",
    destructive: true,
    schema: z.object({ expenseId: z.string().optional(), match: matchSchema.optional() }),
    async prepare(a, ctx) {
      const target = await findTarget(ctx, a.expenseId, a.match);
      return { args: { expenseId: target.id }, summary: `Delete ${describeExpense(target, ctx)}?` };
    },
    async execute(a, ctx) {
      if (!a.expenseId) throw new ToolError("expenseId is required");
      try {
        const e = await expenses.deleteExpense(ctx.userId, a.expenseId);
        return { deleted: brief(e, ctx.timezone) };
      } catch {
        throw new ToolError("That expense no longer exists.");
      }
    },
    confirmedReply: (r, ctx) => {
      const d = r.deleted;
      return `Done, I deleted ${formatMoney(d.amount, ctx.currency)}${d.merchant ? ` at ${d.merchant}` : d.note ? ` for ${d.note}` : ""}.`;
    },
  }),
  tool({
    name: "setBudget",
    description: "Set a category's monthly budget. Changing an existing one is confirmed automatically.",
    schema: z.object({ category: category, monthlyLimit: money }),
    confirmIf: async (a, ctx) => {
      const existing = await BudgetModel.findOne({ userId: oid(ctx.userId), category: a.category }).lean();
      return !!existing && Math.round(existing.monthlyLimit * 100) !== Math.round(a.monthlyLimit * 100);
    },
    async prepare(a, ctx) {
      const existing = await BudgetModel.findOne({ userId: oid(ctx.userId), category: a.category }).lean();
      const from = existing ? `from ${formatMoney(existing.monthlyLimit, ctx.currency)} ` : "";
      return {
        args: { category: a.category, monthlyLimit: a.monthlyLimit },
        summary: `Change your ${a.category} budget ${from}to ${formatMoney(a.monthlyLimit, ctx.currency)} a month?`,
      };
    },
    async execute(a, ctx) {
      return { budget: await budgets.upsertBudget(ctx.userId, a.category, a.monthlyLimit, ctx.timezone) };
    },
    confirmedReply: (r, ctx) => `Done. Your ${r.budget.category} budget is now ${formatMoney(r.budget.monthlyLimit, ctx.currency)} a month.`,
  }),
  tool({
    name: "getBudgets",
    description: "Budgets with amount spent and percent used this month.",
    schema: z.object({}),
    async execute(_a, ctx) {
      return { budgets: await budgets.listBudgets(ctx.userId, ctx.timezone) };
    },
  }),
  tool({
    name: "createReminder",
    description: "Remind the user at a time.",
    schema: z.object({
      text: z.string().min(1).max(200),
      dateTime: dateStr.describe("Local YYYY-MM-DDTHH:mm"),
    }),
    async execute(a, ctx) {
      const when = reminderDate(a.dateTime, ctx.timezone);
      if (Number.isNaN(when.getTime())) throw new ToolError("Invalid dateTime");
      return { reminder: await reminders.createReminder(ctx.userId, a.text, when.toISOString()) };
    },
  }),
  tool({
    name: "listReminders",
    description: "Pending reminders, soonest first.",
    schema: z.object({}),
    async execute(_a, ctx) {
      const list = await reminders.listReminders(ctx.userId, { onlyPending: true, limit: 10 });
      return { reminders: list.map((r) => ({ text: r.text, dateTime: r.dateTime })) };
    },
  }),
  tool({
    name: "manageTask",
    description:
      "To-do lists. add: titles (one per item) to list. list: open tasks (optional list/when). complete/delete: titles matched fuzzily; delete is confirmed automatically.",
    schema: taskSchema,
    hiddenArgs: ["ids"],
    confirmIf: (a) => a.action === "delete",
    async prepare(a, ctx) {
      if (!a.titles?.length) throw new ToolError("Say which task to delete (titles).");
      const { matches, missing } = await tasks.findTasksByTitle(ctx.userId, a.titles, { list: a.list, includeDone: true });
      if (!matches.length) throw new ToolError(`No task matches ${joinWords(missing)}.`);
      const names = matches.map((t) => t.title);
      return {
        args: { action: "delete", ids: matches.map((t) => t.id) },
        summary:
          matches.length === 1
            ? `Delete the task ${names[0]} from ${matches[0].list}?`
            : `Delete ${matches.length} tasks: ${joinWords(names)}?`,
      };
    },
    async execute(a, ctx) {
      switch (a.action) {
        case "add": {
          if (!a.titles?.length) throw new ToolError("titles is required for add");
          const created = [];
          for (const title of a.titles) {
            created.push(await tasks.createTask(ctx.userId, { title, list: a.list, dueDate: a.dueDate, priority: a.priority }, ctx.timezone));
          }
          return { added: created.map((t) => t.title), list: created[0].list, ...(a.dueDate ? { due: a.dueDate } : {}) };
        }
        case "list": {
          const list = await tasks.listTasks(ctx.userId, { list: a.list, done: false, when: a.when }, ctx.timezone, ctx.now);
          return {
            ...(a.list ? { list: tasks.normalizeListName(a.list) } : {}),
            ...(a.when ? { when: a.when } : {}),
            count: list.length,
            tasks: list.slice(0, 15).map((t) => ({
              title: t.title,
              ...(a.list ? {} : { list: t.list }),
              ...(t.dueDate ? { due: ymdIn(t.dueDate, ctx.timezone) } : {}),
            })),
          };
        }
        case "complete": {
          if (!a.titles?.length) throw new ToolError("titles is required for complete");
          const { matches, missing } = await tasks.findTasksByTitle(ctx.userId, a.titles, { list: a.list });
          if (!matches.length) {
            const open = await tasks.listTasks(ctx.userId, { list: a.list, done: false }, ctx.timezone, ctx.now);
            throw new ToolError(
              `No open task matches ${joinWords(missing)}.${open.length ? ` Open tasks: ${open.slice(0, 8).map((t) => t.title).join(", ")}.` : ""}`,
            );
          }
          for (const t of matches) await tasks.updateTask(ctx.userId, t.id, { done: true }, ctx.timezone);
          return { completed: matches.map((t) => t.title), ...(missing.length ? { notFound: missing } : {}) };
        }
        case "delete": {
          if (!a.ids?.length) throw new ToolError("Nothing to delete");
          const deleted = [];
          for (const id of a.ids) {
            try {
              deleted.push((await tasks.deleteTask(ctx.userId, id)).title);
            } catch {
              /* already gone */
            }
          }
          if (!deleted.length) throw new ToolError("Those tasks no longer exist.");
          return { deleted };
        }
      }
    },
    confirmedReply: (r) => `Done, I deleted ${joinWords(r.deleted as string[])}.`,
  }),
  tool({
    name: "manageNote",
    description: "Notes. save: text. search: query. delete: query (confirmed automatically).",
    schema: z.object({
      action: z.enum(["save", "search", "delete"]),
      text: z.string().min(1).max(5000).optional(),
      query: z.string().min(1).max(200).optional(),
      noteId: z.string().optional(),
    }),
    hiddenArgs: ["noteId"],
    confirmIf: (a) => a.action === "delete",
    async prepare(a, ctx) {
      const q = a.query ?? a.text;
      if (!q) throw new ToolError("Say which note to delete (query).");
      const [hit] = await notes.searchNotes(ctx.userId, q, 1);
      if (!hit) throw new ToolError(`No note matches "${q}".`);
      return { args: { action: "delete", noteId: hit.id }, summary: `Delete your note: ${clip(hit.text, 80)}?` };
    },
    async execute(a, ctx) {
      if (a.action === "save") {
        const text = a.text ?? a.query;
        if (!text) throw new ToolError("text is required for save");
        const n = await notes.createNote(ctx.userId, text);
        return { saved: clip(n.text, 200) };
      }
      if (a.action === "search") {
        const q = a.query ?? a.text;
        if (!q) throw new ToolError("query is required for search");
        const hits = await notes.searchNotes(ctx.userId, q, 3);
        return { notes: hits.map((n) => ({ text: clip(n.text, 300), date: localDateString(new Date(n.updatedAt), ctx.timezone) })) };
      }
      if (!a.noteId) throw new ToolError("Nothing to delete");
      try {
        return { deleted: clip((await notes.deleteNote(ctx.userId, a.noteId)).text, 80) };
      } catch {
        throw new ToolError("That note no longer exists.");
      }
    },
    confirmedReply: () => "Done, I deleted that note.",
  }),
  tool({
    name: "getWeather",
    description: "Current weather and forecast. Omit city for the user's home city.",
    schema: z.object({ city: z.string().max(80).optional(), day: z.enum(["today", "tomorrow"]).optional() }),
    async execute(a, ctx) {
      let place: { name: string; lat: number; lon: number } | null = null;
      try {
        if (a.city) {
          place = await geocodeCity(a.city);
          if (!place) throw new ToolError(`I couldn't find a city called ${a.city}.`);
        } else if (ctx.user?.city && typeof ctx.user.cityLat === "number" && typeof ctx.user.cityLon === "number") {
          place = { name: ctx.user.city, lat: ctx.user.cityLat, lon: ctx.user.cityLon };
        } else {
          throw new ToolError("No home city is set. Ask which city, or the user can set one in settings.");
        }
        const f = await getForecast(place);
        if (a.day === "tomorrow" && f.tomorrow) return { city: f.city, day: "tomorrow", ...f.tomorrow };
        return { city: f.city, now: f.current, today: f.today };
      } catch (e) {
        if (e instanceof WeatherError) throw new ToolError("The weather service isn't responding right now.");
        throw e;
      }
    },
  }),
  tool({
    name: "getDailyBriefing",
    description: "Today's briefing: weather, reminders, tasks due, spending, budget alerts.",
    schema: z.object({}),
    async execute(_a, ctx) {
      const user = ctx.user ?? { _id: ctx.userId, name: "there", currency: ctx.currency };
      const b = await buildDailyBriefing(user, ctx.timezone, ctx.now);
      return { briefing: b.text };
    },
  }),
  tool({
    name: "getWeeklyReport",
    description: "Spending report for a Monday-Sunday week (default last week) vs the week before.",
    schema: z.object({ weekStart: dateStr.optional().describe("Monday") }),
    async execute(a, ctx) {
      const r = await buildWeeklyReport(ctx.userId, { weekStart: a.weekStart?.slice(0, 10), currency: ctx.currency }, ctx.timezone, ctx.now);
      return { report: r.text, weekStart: r.weekStart, total: r.total, previousTotal: r.previousTotal };
    },
  }),
  tool({
    name: "manageMemory",
    description: "Lasting facts about the user. save: fact. list. forget: query (confirmed automatically).",
    schema: z.object({
      action: z.enum(["save", "list", "forget"]),
      fact: z.string().min(1).max(300).optional(),
      query: z.string().min(1).max(200).optional(),
      memoryId: z.string().optional(),
    }),
    hiddenArgs: ["memoryId"],
    confirmIf: (a) => a.action === "forget",
    async prepare(a, ctx) {
      const q = a.query ?? a.fact;
      if (!q) throw new ToolError("Say which memory to forget (query).");
      const hit = await findMemory(ctx.userId, q);
      if (!hit) throw new ToolError(`I don't have a memory about "${q}".`);
      return { args: { action: "forget", memoryId: hit._id.toString() }, summary: `Forget that ${hit.fact}?` };
    },
    async execute(a, ctx) {
      if (a.action === "save") {
        const fact = (a.fact ?? a.query ?? "").trim();
        if (!fact) throw new ToolError("fact is required for save");
        if (looksLikeInstruction(fact)) {
          throw new ToolError("That sounds like an instruction rather than a fact about the user, so it was not saved.");
        }
        const exists = await MemoryModel.exists({ userId: oid(ctx.userId), fact });
        if (!exists) await MemoryModel.create({ userId: oid(ctx.userId), fact });
        // Keep memory bounded: drop the oldest beyond 100.
        const extra = await MemoryModel.find({ userId: oid(ctx.userId) }).sort({ createdAt: -1 }).skip(100).select("_id").lean();
        if (extra.length) await MemoryModel.deleteMany({ _id: { $in: extra.map((m) => m._id) } });
        return { saved: fact };
      }
      if (a.action === "list") {
        const list = await MemoryModel.find({ userId: oid(ctx.userId) }).sort({ createdAt: -1 }).limit(20).lean();
        return { count: list.length, facts: list.map((m) => clip(m.fact, 150)) };
      }
      if (!a.memoryId || !isValidObjectId(a.memoryId)) throw new ToolError("Nothing to forget");
      const gone = await MemoryModel.findOneAndDelete({ _id: a.memoryId, userId: oid(ctx.userId) }).lean();
      if (!gone) throw new ToolError("That memory no longer exists.");
      return { forgotten: gone.fact };
    },
    confirmedReply: (r) => `Okay, I've forgotten that ${r.forgotten}.`,
  }),
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));
TOOL_NAMES_LOWER.push(...TOOLS.map((t) => t.name.toLowerCase()));

/** Only addExpense carries the category enum; the others reference it to save prompt tokens. */
const CATEGORY_ENUM_TOOL = "addExpense";

function jsonSchemaFor(schema: ZodTypeAny, opts: { hide?: string[]; categoryEnum?: boolean } = {}): Record<string, unknown> {
  // jsonSchema7, not openApi3: OpenAPI 3.0 emits boolean `exclusiveMinimum`, which providers that
  // validate against JSON Schema 2020-12 (e.g. Groq) reject.
  const js = zodToJsonSchema(schema, { $refStrategy: "none", target: "jsonSchema7", pipeStrategy: "input" }) as Record<string, unknown>;
  delete js.$schema;
  delete js.additionalProperties;
  if (!js.type) js.type = "object";
  if (!js.properties) js.properties = {};
  const props = js.properties as Record<string, Record<string, unknown>>;
  for (const h of opts.hide ?? []) delete props[h];
  // Categories are listed once in the system prompt and in addExpense; elsewhere the enum is redundant.
  if (!opts.categoryEnum && props.category?.enum) delete props.category.enum;
  // Models often send null for an omitted optional, and Groq rejects the whole call ("tool_use_failed")
  // if the schema doesn't allow it. Accept null here; stripNulls drops it before Zod validates.
  const required = new Set((js.required as string[] | undefined) ?? []);
  for (const [k, p] of Object.entries(props)) {
    if (required.has(k) || typeof p.type !== "string") continue;
    p.type = [p.type, "null"];
    if (Array.isArray(p.enum)) p.enum = [...p.enum, null];
  }
  return stripValidationKeywords(js) as Record<string, unknown>;
}

/** Bounds and defaults are enforced by Zod on our side; sending them to the model only costs tokens. */
const VALIDATION_KEYWORDS = new Set(["minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "maxItems", "minItems", "additionalProperties", "default"]);
function stripValidationKeywords(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripValidationKeywords);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([k]) => !VALIDATION_KEYWORDS.has(k))
        .map(([k, x]) => [k, k === "properties" ? Object.fromEntries(Object.entries(x as object).map(([pk, pv]) => [pk, stripValidationKeywords(pv)])) : stripValidationKeywords(x)]),
    );
  }
  return v;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = TOOLS.map((t) => ({
  type: "function",
  function: {
    name: t.name,
    description: t.description,
    parameters: jsonSchemaFor(t.schema, { hide: t.hiddenArgs, categoryEnum: t.name === CATEGORY_ENUM_TOOL }),
  },
}));

/** Drop null values (some models send null for omitted optionals). */
export function stripNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripNulls);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== null)
        .map(([k, x]) => [k, stripNulls(x)]),
    );
  }
  return v;
}

export function formatZodIssues(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ");
}
