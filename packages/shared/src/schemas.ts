import { z } from "zod";

// ---------- Config ----------

/** Default assistant name. Users can override it per-account (User.assistantName). */
export const ASSISTANT_NAME = "Nova";
export const DEFAULT_CURRENCY = "INR";

export const CATEGORIES = [
  "Food",
  "Groceries",
  "Transport",
  "Shopping",
  "Bills",
  "Rent",
  "Entertainment",
  "Health",
  "Education",
  "Travel",
  "Other",
] as const;
export const CategorySchema = z.enum(CATEGORIES);
export type Category = z.infer<typeof CategorySchema>;

/** ISO date string, e.g. "2026-10-30" or full ISO datetime. */
const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "Invalid date");

// ---------- Users / Auth ----------

export const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  currency: z.string().default(DEFAULT_CURRENCY),
  assistantName: z.string().default(ASSISTANT_NAME),
  createdAt: isoDate,
});
export type User = z.infer<typeof UserSchema>;

export const RegisterSchema = z.object({
  name: z.string().min(1).max(80),
  email: z.string().email(),
  password: z.string().min(8).max(128),
});
export type RegisterInput = z.infer<typeof RegisterSchema>;

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof LoginSchema>;

export type AuthResponse = { token: string; user: User };

export const UpdateMeSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  currency: z.string().length(3).optional(),
  assistantName: z.string().min(1).max(30).optional(),
});
export type UpdateMeInput = z.infer<typeof UpdateMeSchema>;

// ---------- Expenses ----------

export const ExpenseSourceSchema = z.enum(["voice", "manual", "receipt"]);
export type ExpenseSource = z.infer<typeof ExpenseSourceSchema>;

export const ExpenseSchema = z.object({
  id: z.string(),
  amount: z.number().positive(),
  category: CategorySchema,
  merchant: z.string().optional(),
  note: z.string().optional(),
  date: isoDate,
  source: ExpenseSourceSchema,
  createdAt: isoDate,
});
export type Expense = z.infer<typeof ExpenseSchema>;

export const CreateExpenseSchema = z.object({
  amount: z.number().positive().max(100_000_000),
  category: CategorySchema,
  merchant: z.string().max(100).optional(),
  note: z.string().max(500).optional(),
  date: isoDate.optional(), // defaults to now on the server
  source: ExpenseSourceSchema.default("manual"),
});
export type CreateExpenseInput = z.input<typeof CreateExpenseSchema>;

export const UpdateExpenseSchema = CreateExpenseSchema.partial();
export type UpdateExpenseInput = z.input<typeof UpdateExpenseSchema>;

export const ExpenseQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  category: CategorySchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type ExpenseQuery = z.input<typeof ExpenseQuerySchema>;

export type SpendingSummary = {
  from: string;
  to: string;
  total: number;
  count: number;
  byCategory: { category: Category; total: number; count: number }[];
  byDay: { date: string; total: number }[]; // date = "YYYY-MM-DD"
};

// ---------- Budgets ----------

export const UpsertBudgetSchema = z.object({
  category: CategorySchema,
  monthlyLimit: z.number().positive(),
});
export type UpsertBudgetInput = z.infer<typeof UpsertBudgetSchema>;

/** Budget for the current calendar month, with spending computed by the server. */
export type BudgetStatus = {
  category: Category;
  monthlyLimit: number;
  spent: number;
  percentUsed: number; // 0-100+ (can exceed 100)
};

// ---------- Reminders ----------

export const CreateReminderSchema = z.object({
  text: z.string().min(1).max(200),
  dateTime: isoDate,
});
export type CreateReminderInput = z.infer<typeof CreateReminderSchema>;

export type Reminder = {
  id: string;
  text: string;
  dateTime: string;
  done: boolean;
  createdAt: string;
};

// ---------- Agent (voice assistant) ----------

export const AgentRequestSchema = z.object({
  /** Transcribed user speech (speech-to-text happens on the device). */
  message: z.string().min(1).max(2000),
  conversationId: z.string().optional(),
  /** Client's IANA timezone, e.g. "Asia/Kolkata", so "today"/"this month" resolve correctly. */
  timezone: z.string().optional(),
});
export type AgentRequest = z.infer<typeof AgentRequestSchema>;

export type AgentAction = {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  result?: unknown;
  error?: string;
};

export type AgentResponse = {
  /** Text the client should display and speak with TTS. */
  reply: string;
  conversationId: string;
  /** Tools the agent executed this turn — clients refresh their data if any ran. */
  actions: AgentAction[];
  /**
   * Set when a destructive action awaits a yes/no. The client just sends the user's
   * next utterance ("yes" / "no") as a normal AgentRequest with the same conversationId.
   */
  pendingConfirmation?: { summary: string };
};

// ---------- Errors ----------

export type ApiErrorBody = { error: { code: string; message: string; details?: unknown } };
