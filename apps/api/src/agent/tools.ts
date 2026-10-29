import { z, type ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { Types, isValidObjectId } from "mongoose";
import { CATEGORIES, type Category, type Expense } from "@nova/shared";
import { ExpenseModel } from "../models/Expense";
import { MemoryModel } from "../models/Memory";
import * as expenses from "../services/expenses";
import * as budgets from "../services/budgets";
import * as reminders from "../services/reminders";
import { isDateOnly, localDateString, zonedToUtc } from "../services/dates";
import { toExpense } from "../services/serialize";
import { formatMoney, speakDay } from "./format";
import type { ToolDefinition } from "./llm";

export type ToolContext = { userId: string; timezone: string; now: Date; currency: string };

/** A tool failure that is reported back to the model (not a server error). */
export class ToolError extends Error {}

type Prepared = { args: Record<string, unknown>; summary: string };

export type Tool<S extends ZodTypeAny = ZodTypeAny> = {
  name: string;
  description: string;
  schema: S;
  /** Destructive tools are never run directly: prepare() resolves the target and returns a yes/no summary. */
  destructive?: boolean;
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
const money = z.coerce.number().positive().max(100_000_000);
const matchSchema = z
  .object({
    merchant: z.string().optional().describe("Merchant name to look for (case-insensitive)"),
    amount: money.optional().describe("Amount of the expense to look for"),
  })
  .describe("Hints to find the expense when expenseId is unknown. Omit to target the most recent expense.");

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
  date: dateStr.optional().describe("New date, YYYY-MM-DD"),
});

export const TOOLS: Tool[] = [
  tool({
    name: "addExpense",
    description:
      "Record an expense the user made. Returns the saved expense and the current-month budget status for its category.",
    schema: z.object({
      amount: money.describe("Amount in the user's currency, e.g. 250"),
      category: category.describe("Best matching category"),
      merchant: z.string().max(100).optional().describe("Where the money was spent, e.g. Swiggy, Uber"),
      note: z.string().max(500).optional().describe("What it was for, e.g. lunch"),
      date: dateStr.optional().describe("YYYY-MM-DD in the user's local timezone. Omit for today."),
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
    description: "List the user's most recent expenses (newest first), optionally filtered by category or date range.",
    schema: z.object({
      limit: z.coerce.number().int().min(1).max(20).default(5),
      category: category.optional(),
      from: dateStr.optional().describe("YYYY-MM-DD inclusive"),
      to: dateStr.optional().describe("YYYY-MM-DD inclusive"),
    }),
    async execute(a, ctx) {
      const list = await expenses.listExpenses(ctx.userId, a, ctx.timezone);
      return { expenses: list.map((e) => brief(e, ctx.timezone)) };
    },
  }),
  tool({
    name: "getSpendingSummary",
    description:
      "Get exact spending totals (overall, by category, by day) for a date range. Always use this for any total or comparison; never add numbers yourself. Defaults to the current calendar month.",
    schema: z.object({
      from: dateStr.optional().describe("YYYY-MM-DD inclusive start. Omit for start of this month."),
      to: dateStr.optional().describe("YYYY-MM-DD inclusive end. Omit for end of this month."),
      category: category.optional().describe("Only count this category"),
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
    description:
      "Change an existing expense. Identify it by expenseId (from listRecentExpenses) or by match hints; omit both for the most recent expense. The user will be asked to confirm automatically.",
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
  }),
  tool({
    name: "deleteExpense",
    description:
      "Delete an expense. Identify it by expenseId or match hints; omit both for the most recent expense. The user will be asked to confirm automatically.",
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
  }),
  tool({
    name: "setBudget",
    description: "Create or update the monthly budget limit for a category.",
    schema: z.object({ category: category, monthlyLimit: money.describe("Monthly limit amount") }),
    async execute(a, ctx) {
      return { budget: await budgets.upsertBudget(ctx.userId, a.category, a.monthlyLimit, ctx.timezone) };
    },
  }),
  tool({
    name: "getBudgets",
    description: "Get all budgets with exact amount spent this month and percent used.",
    schema: z.object({}),
    async execute(_a, ctx) {
      return { budgets: await budgets.listBudgets(ctx.userId, ctx.timezone) };
    },
  }),
  tool({
    name: "createReminder",
    description: "Create a reminder for the user at a date/time.",
    schema: z.object({
      text: z.string().min(1).max(200).describe("What to remind about, e.g. 'pay rent'"),
      dateTime: dateStr.describe(
        "When, as local time 'YYYY-MM-DDTHH:mm' in the user's timezone (or YYYY-MM-DD for 9 AM that day)",
      ),
    }),
    async execute(a, ctx) {
      const when = reminderDate(a.dateTime, ctx.timezone);
      if (Number.isNaN(when.getTime())) throw new ToolError("Invalid dateTime");
      return { reminder: await reminders.createReminder(ctx.userId, a.text, when.toISOString()) };
    },
  }),
  tool({
    name: "listReminders",
    description: "List the user's pending reminders, soonest first.",
    schema: z.object({}),
    async execute(_a, ctx) {
      return { reminders: await reminders.listReminders(ctx.userId, { onlyPending: true, limit: 10 }) };
    },
  }),
  tool({
    name: "rememberFact",
    description:
      "Save a lasting fact or preference about the user (e.g. 'salary arrives on the 1st', 'vegetarian') to remember in future conversations.",
    schema: z.object({ fact: z.string().min(1).max(300) }),
    async execute(a, ctx) {
      const fact = a.fact.trim();
      const exists = await MemoryModel.exists({ userId: oid(ctx.userId), fact });
      if (!exists) await MemoryModel.create({ userId: oid(ctx.userId), fact });
      // Keep memory bounded: drop the oldest beyond 100.
      const extra = await MemoryModel.find({ userId: oid(ctx.userId) }).sort({ createdAt: -1 }).skip(100).select("_id").lean();
      if (extra.length) await MemoryModel.deleteMany({ _id: { $in: extra.map((m) => m._id) } });
      return { saved: fact };
    },
  }),
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

function jsonSchemaFor(schema: ZodTypeAny): Record<string, unknown> {
  // jsonSchema7, not openApi3: OpenAPI 3.0 emits boolean `exclusiveMinimum`, which providers that
  // validate against JSON Schema 2020-12 (e.g. Groq) reject.
  const js = zodToJsonSchema(schema, { $refStrategy: "none", target: "jsonSchema7", pipeStrategy: "input" }) as Record<string, unknown>;
  delete js.$schema;
  delete js.additionalProperties;
  if (!js.type) js.type = "object";
  if (!js.properties) js.properties = {};
  return js;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = TOOLS.map((t) => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: jsonSchemaFor(t.schema) },
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
