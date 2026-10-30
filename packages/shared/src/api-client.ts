import type {
  AgentRequest,
  AgentResponse,
  ApiErrorBody,
  AuthResponse,
  BudgetStatus,
  CreateExpenseInput,
  CreateNoteInput,
  CreateReminderInput,
  CreateTaskInput,
  DailyBriefing,
  Expense,
  ExpenseQuery,
  LoginInput,
  NaturalVoicesResult,
  Note,
  ReceiptScanResult,
  RegisterInput,
  Reminder,
  ScanReceiptInput,
  SpeakInput,
  SpeakResult,
  SpendingSummary,
  Task,
  TaskQuery,
  TranscribeInput,
  UpdateExpenseInput,
  UpdateMeInput,
  UpdateTaskInput,
  UpsertBudgetInput,
  User,
  WeeklyReport,
} from "./schemas";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export type ApiClientOptions = {
  /** e.g. "http://localhost:4000" — no trailing slash. */
  baseUrl: string;
  /** Returns the current JWT, or null when logged out. */
  getToken: () => string | null | Promise<string | null>;
  /** Called on any 401 so the app can log the user out. */
  onUnauthorized?: () => void;
};

/** Typed client for the Nova REST API. Shared by web (Next.js) and mobile (Expo). */
/** The device's IANA timezone, so "today" and "this month" match the user's clock. */
function deviceTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

export function createApiClient({ baseUrl, getToken, onUnauthorized }: ApiClientOptions) {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await getToken();
    const tz = deviceTimezone();
    const res = await fetch(`${baseUrl}/api${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(tz ? { "X-Timezone": tz } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return undefined as T;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      if (res.status === 401) onUnauthorized?.();
      const err = (data as ApiErrorBody | null)?.error;
      throw new ApiError(res.status, err?.code ?? "UNKNOWN", err?.message ?? res.statusText, err?.details);
    }
    return data as T;
  }

  const qs = (params: Record<string, unknown>) => {
    const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "");
    return entries.length ? "?" + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString() : "";
  };

  return {
    auth: {
      register: (input: RegisterInput) => request<AuthResponse>("POST", "/auth/register", input),
      login: (input: LoginInput) => request<AuthResponse>("POST", "/auth/login", input),
      me: () => request<{ user: User }>("GET", "/auth/me"),
      updateMe: (input: UpdateMeInput) => request<{ user: User }>("PATCH", "/auth/me", input),
    },
    expenses: {
      list: (query: ExpenseQuery = {}) => request<{ expenses: Expense[] }>("GET", `/expenses${qs(query)}`),
      create: (input: CreateExpenseInput) => request<{ expense: Expense }>("POST", "/expenses", input),
      update: (id: string, input: UpdateExpenseInput) =>
        request<{ expense: Expense }>("PATCH", `/expenses/${id}`, input),
      remove: (id: string) => request<void>("DELETE", `/expenses/${id}`),
      summary: (query: { from?: string; to?: string } = {}) =>
        request<SpendingSummary>("GET", `/expenses/summary${qs(query)}`),
    },
    budgets: {
      list: () => request<{ budgets: BudgetStatus[] }>("GET", "/budgets"),
      upsert: (input: UpsertBudgetInput) => request<{ budget: BudgetStatus }>("PUT", "/budgets", input),
      remove: (category: string) => request<void>("DELETE", `/budgets/${encodeURIComponent(category)}`),
    },
    reminders: {
      list: () => request<{ reminders: Reminder[] }>("GET", "/reminders"),
      create: (input: CreateReminderInput) => request<{ reminder: Reminder }>("POST", "/reminders", input),
      setDone: (id: string, done: boolean) =>
        request<{ reminder: Reminder }>("PATCH", `/reminders/${id}`, { done }),
      remove: (id: string) => request<void>("DELETE", `/reminders/${id}`),
    },
    tasks: {
      list: (query: TaskQuery = {}) => request<{ tasks: Task[] }>("GET", `/tasks${qs(query)}`),
      create: (input: CreateTaskInput) => request<{ task: Task }>("POST", "/tasks", input),
      update: (id: string, input: UpdateTaskInput) => request<{ task: Task }>("PATCH", `/tasks/${id}`, input),
      remove: (id: string) => request<void>("DELETE", `/tasks/${id}`),
    },
    notes: {
      list: (query: { q?: string } = {}) => request<{ notes: Note[] }>("GET", `/notes${qs(query)}`),
      create: (input: CreateNoteInput) => request<{ note: Note }>("POST", "/notes", input),
      update: (id: string, input: CreateNoteInput) => request<{ note: Note }>("PATCH", `/notes/${id}`, input),
      remove: (id: string) => request<void>("DELETE", `/notes/${id}`),
    },
    briefing: {
      today: (query: { tz?: string } = {}) => request<DailyBriefing>("GET", `/briefing${qs(query)}`),
    },
    reports: {
      weekly: (query: { weekStart?: string; tz?: string } = {}) =>
        request<WeeklyReport>("GET", `/reports/weekly${qs(query)}`),
    },
    receipts: {
      scan: (input: ScanReceiptInput) => request<ReceiptScanResult>("POST", "/receipts/scan", input),
    },
    voice: {
      transcribe: (input: TranscribeInput) => request<{ text: string }>("POST", "/transcribe", input),
      /** Natural (server) voices and whether they can be used right now. */
      naturalVoices: () => request<NaturalVoicesResult>("GET", "/speak/voices"),
      speak: (input: SpeakInput) => request<SpeakResult>("POST", "/speak", input),
    },
    agent: {
      send: (input: AgentRequest) => request<AgentResponse>("POST", "/agent", input),
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
