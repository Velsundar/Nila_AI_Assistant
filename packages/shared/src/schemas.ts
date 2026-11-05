import { z } from "zod";

// ---------- Config ----------

/** Default assistant name. Users can override it per-account (User.assistantName). */
export const ASSISTANT_NAME = "Nila";
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

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** True for a real calendar day ("2026-02-31" is rejected rather than rolled over). */
function isRealDay(y: string, m: string, d: string) {
  const dt = new Date(Date.UTC(+y, +m - 1, +d));
  return dt.getUTCFullYear() === +y && dt.getUTCMonth() === +m - 1 && dt.getUTCDate() === +d;
}

/**
 * "YYYY-MM-DD" (a calendar day, interpreted in the user's timezone) or a full ISO datetime with
 * "Z" or an offset. Ambiguous forms like "10/30/2026" would parse in the server's timezone, so
 * they are rejected.
 */
const isoDate = z.string().refine((s) => {
  const m = DATE_ONLY.exec(s) ?? DATE_TIME.exec(s);
  return !!m && isRealDay(m[1]!, m[2]!, m[3]!) && !Number.isNaN(Date.parse(s));
}, "Invalid date: use YYYY-MM-DD or an ISO datetime with a timezone offset");

// ---------- Users / Auth ----------

export const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  currency: z.string().default(DEFAULT_CURRENCY),
  assistantName: z.string().default(ASSISTANT_NAME),
  /** Home city for weather in the daily briefing. The server geocodes it. */
  city: z.string().optional(),
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
  /** Empty string clears it. Unknown city → 400 VALIDATION_ERROR. */
  city: z.string().max(80).optional(),
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

// ---------- Income (money received: salary, refunds, someone paying you back) ----------
// Kept apart from expenses so spending totals, budgets and reports never count money coming in.

export const INCOME_CATEGORIES = ["Salary", "Business", "Refund", "Gift", "Transfer", "Interest", "Other"] as const;
export const IncomeCategorySchema = z.enum(INCOME_CATEGORIES);
export type IncomeCategory = z.infer<typeof IncomeCategorySchema>;

export const IncomeSchema = z.object({
  id: z.string(),
  amount: z.number().positive(),
  category: IncomeCategorySchema,
  /** Who paid, e.g. "Acme Corp" or "Ravi". */
  payer: z.string().optional(),
  note: z.string().optional(),
  date: isoDate,
  source: ExpenseSourceSchema,
  createdAt: isoDate,
});
export type Income = z.infer<typeof IncomeSchema>;

export const CreateIncomeSchema = z.object({
  amount: z.number().positive().max(100_000_000),
  category: IncomeCategorySchema.default("Other"),
  payer: z.string().max(100).optional(),
  note: z.string().max(500).optional(),
  date: isoDate.optional(), // defaults to now on the server
  source: ExpenseSourceSchema.default("manual"),
});
export type CreateIncomeInput = z.input<typeof CreateIncomeSchema>;

export const UpdateIncomeSchema = CreateIncomeSchema.partial();
export type UpdateIncomeInput = z.input<typeof UpdateIncomeSchema>;

export const IncomeQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  category: IncomeCategorySchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type IncomeQuery = z.input<typeof IncomeQuerySchema>;

export type IncomeSummary = {
  from: string;
  to: string;
  total: number;
  count: number;
  byCategory: { category: IncomeCategory; total: number; count: number }[];
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

// ---------- Tasks (to-dos and lists, e.g. "Shopping") ----------

export const TaskPrioritySchema = z.enum(["low", "normal", "high"]);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

export const DEFAULT_TASK_LIST = "Inbox";

export type Task = {
  id: string;
  title: string;
  /** List name, e.g. "Inbox", "Shopping", "Work". Case-insensitive match on the server. */
  list: string;
  dueDate?: string;
  priority: TaskPriority;
  done: boolean;
  completedAt?: string;
  createdAt: string;
};

export const CreateTaskSchema = z.object({
  title: z.string().min(1).max(200),
  list: z.string().min(1).max(40).default(DEFAULT_TASK_LIST),
  dueDate: isoDate.optional(),
  priority: TaskPrioritySchema.default("normal"),
});
export type CreateTaskInput = z.input<typeof CreateTaskSchema>;

export const UpdateTaskSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  list: z.string().min(1).max(40).optional(),
  dueDate: isoDate.nullable().optional(), // null clears it
  priority: TaskPrioritySchema.optional(),
  done: z.boolean().optional(),
});
export type UpdateTaskInput = z.input<typeof UpdateTaskSchema>;

export const TaskQuerySchema = z.object({
  list: z.string().optional(),
  done: z.enum(["true", "false"]).optional(),
});
export type TaskQuery = z.input<typeof TaskQuerySchema>;

// ---------- Notes ----------

export type Note = { id: string; text: string; createdAt: string; updatedAt: string };

export const CreateNoteSchema = z.object({ text: z.string().min(1).max(5000) });
export type CreateNoteInput = z.infer<typeof CreateNoteSchema>;

// ---------- Daily briefing & weekly report ----------

export type Weather = {
  city: string;
  tempC: number;
  condition: string; // e.g. "Light rain"
  highC: number;
  lowC: number;
  rainChance: number; // 0-100
};

export type DailyBriefing = {
  /** Spoken-style briefing, ready for TTS. */
  text: string;
  date: string; // YYYY-MM-DD in the user's timezone
  weather?: Weather; // absent if the user has no city or the weather service failed
  reminders: Reminder[]; // due today
  tasksDue: Task[]; // open tasks due today or overdue
  spentYesterday: number;
  spentThisMonth: number;
  budgetAlerts: BudgetStatus[]; // budgets at >= 80%
};

export type WeeklyReport = {
  /** Spoken-style summary, ready for TTS. */
  text: string;
  weekStart: string; // YYYY-MM-DD (Monday)
  weekEnd: string; // YYYY-MM-DD (Sunday)
  total: number;
  previousTotal: number;
  /** null when the previous week had no spending. */
  changePercent: number | null;
  byCategory: { category: Category; total: number; count: number }[];
  topMerchants: { merchant: string; total: number; count: number }[];
};

// ---------- Receipt scanning ----------

export const ScanReceiptSchema = z.object({
  /** Image as a data URL: "data:image/jpeg;base64,...". Max ~4 MB decoded. */
  image: z.string().startsWith("data:image/"),
});
export type ScanReceiptInput = z.infer<typeof ScanReceiptSchema>;

export type ReceiptScanResult = {
  /** Prefill for the add-expense form. The client asks the user to confirm before saving. */
  draft: {
    amount?: number;
    merchant?: string;
    date?: string;
    category?: Category;
    note?: string;
  };
  confidence: "high" | "medium" | "low";
};

// ---------- Server-side speech-to-text (fallback when on-device STT is unavailable) ----------

export const TranscribeSchema = z.object({
  /** Audio as a data URL, e.g. "data:audio/webm;base64,..." or "data:audio/m4a;base64,...". Max ~10 MB decoded. */
  audio: z.string().startsWith("data:audio/"),
  /** ISO-639-1, e.g. "en". */
  language: z.string().min(2).max(5).optional(),
});
export type TranscribeInput = z.infer<typeof TranscribeSchema>;

// ---------- Natural voice (server text-to-speech, Groq Orpheus) ----------

/**
 * One short piece of speech. Clients split replies into sentences and request them one at a
 * time, so the first sentence starts playing while the next is generated.
 */
export const SpeakSchema = z.object({
  text: z.string().trim().min(1).max(400),
  /** A voice id from GET /api/speak/voices; the server default if omitted. */
  voice: z.string().max(40).optional(),
});
export type SpeakInput = z.infer<typeof SpeakSchema>;

export type SpeakResult = {
  /** "data:audio/wav;base64,..." */
  audio: string;
  voice: string;
};

export type NaturalVoice = { id: string; gender?: "female" | "male" };

export type NaturalVoicesResult = {
  /** false when the server has no key, or the Groq account hasn't accepted the model's terms. */
  available: boolean;
  reason?: "NO_KEY" | "TERMS_REQUIRED" | "UNAVAILABLE";
  voices: NaturalVoice[];
  /** Server default voice (female). */
  defaultVoice?: string;
};

/**
 * Short acknowledgements the assistant says when the user interrupts it ("Mm-hmm", "Okay").
 * Clients cache their audio once rather than generating it per use.
 */
export const INTERRUPT_ACKS = ["Mm-hmm.", "Okay.", "Ah, got it.", "Sure."] as const;

// ---------- Agent (voice assistant) ----------

export const AgentRequestSchema = z.object({
  /** Transcribed user speech (speech-to-text happens on the device). */
  message: z.string().trim().min(1).max(2000),
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
