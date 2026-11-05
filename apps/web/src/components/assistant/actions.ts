import type { AgentAction } from "@nova/shared";
import { formatMoney } from "@/lib/format";

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v && !Number.isNaN(Number(v)) ? Number(v) : undefined);

/** Pull a nested object like result.expense / result.budget if the tool returned one. */
function pick(result: unknown, key: string): Record<string, unknown> {
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    const inner = r[key];
    if (inner && typeof inner === "object") return inner as Record<string, unknown>;
    return r;
  }
  return {};
}

/** Which kind of chip to show (drives the chip's icon). */
export type ActionKind = "expense" | "income" | "money" | "budget" | "reminder" | "task" | "note" | "weather" | "briefing" | "report" | "memory" | "other";

export function actionKind(tool: string): ActionKind {
  const t = tool.toLowerCase();
  if (/weather|forecast/.test(t)) return "weather";
  // getMoneyOverview (balance / trends): before "income" and "expense".
  if (/overview|balance|ledger|trend|saving/.test(t)) return "money";
  // Before "summary"/"expense": manageIncome's summary action is about money received, not spent.
  if (/income|salary|received/.test(t)) return "income";
  if (/brief/.test(t)) return "briefing";
  if (/weekly|report/.test(t)) return "report";
  if (/task|todo|to_do|checklist|shopping/.test(t)) return "task";
  if (/note/.test(t)) return "note";
  if (/budget/.test(t)) return "budget";
  if (/remind/.test(t)) return "reminder";
  if (/remember|fact|memory/.test(t)) return "memory";
  if (/expense|spend|summary|purchase|transaction/.test(t)) return "expense";
  return "other";
}

export const ACTION_ICON: Record<ActionKind, string> = {
  expense: "₹",
  income: "↓",
  money: "⚖",
  budget: "◔",
  reminder: "⏰",
  task: "☑",
  note: "✎",
  weather: "☁",
  briefing: "☀",
  report: "📊",
  memory: "✦",
  other: "•",
};

/** Short human label for a tool the agent ran, e.g. "Added ₹250 · Food". */
export function describeAction(a: AgentAction, currency = "INR"): string {
  const tool = a.tool.toLowerCase();
  const kind = actionKind(tool);
  const resultKey = { budget: "budget", reminder: "reminder", task: "task", note: "note", weather: "weather", report: "report", briefing: "briefing", income: "income" }[kind as string] ?? "expense";
  const result = pick(a.result, resultKey);
  const args = { ...result, ...a.args };
  const amount = num(args.amount) ?? num(args.monthlyLimit);
  const money = amount !== undefined ? formatMoney(amount, currency) : undefined;
  const category = str(args.category);
  const merchant = str(args.merchant);
  const join = (...p: (string | undefined)[]) => p.filter(Boolean).join(" · ");
  const clip = (s: string | undefined, n = 36) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s);

  if (!a.ok) return `Couldn't ${humanize(a.tool)}${a.error ? `: ${clip(a.error, 60)}` : ""}`;

  switch (kind) {
    case "weather": {
      // getWeather → { city, now: { tempC, condition } } or { city, day: "tomorrow", condition, highC, … }
      const w = pick(a.result, "weather");
      const now = (w.now && typeof w.now === "object" ? w.now : w) as Record<string, unknown>;
      const temp = num(now.tempC) ?? num(now.highC);
      const day = str(w.day) === "tomorrow" ? "tomorrow" : undefined;
      return join("Weather", str(w.city) ?? str(args.city), day, temp !== undefined ? `${Math.round(temp)}°C` : undefined, str(now.condition));
    }
    case "briefing":
      return "Daily briefing";
    case "report": {
      const total = num(pick(a.result, "report").total);
      return join("Weekly report", total !== undefined ? formatMoney(total, currency) : undefined);
    }
    case "task": {
      // manageTask { action: add|list|complete|delete, titles[], list } → { added[] | completed[] | deleted[] | tasks[] }
      const r = (a.result && typeof a.result === "object" ? a.result : {}) as Record<string, unknown>;
      const names = (k: string) => (Array.isArray(r[k]) ? (r[k] as unknown[]).filter((x): x is string => typeof x === "string") : undefined);
      const listTitles = (xs?: string[]) => (xs && xs.length ? clip(xs.join(", "), 40) : undefined);
      const titlesArg = Array.isArray(args.titles) ? (args.titles as unknown[]).filter((x): x is string => typeof x === "string") : undefined;
      const title = listTitles(titlesArg) ?? clip(str(args.title) ?? str(args.text) ?? str(args.item));
      const list = str(r.list) ?? str(args.list);
      const action = str(args.action)?.toLowerCase() ?? tool;
      if (/(delete|remove)/.test(action)) return join("Task removed", listTitles(names("deleted")) ?? title);
      if (/(complete|done|check|finish)/.test(action) || args.done === true) return join("Done", listTitles(names("completed")) ?? title);
      if (/(add|create|new)/.test(action)) return join("Task added", listTitles(names("added")) ?? title, list && list !== "Inbox" ? list : undefined);
      if (/(update|edit|change|move)/.test(action)) return join("Task updated", title);
      const tasks = num(r.count) ?? (Array.isArray(r.tasks) ? r.tasks.length : undefined);
      return join(list ? `Checked ${list}` : "Checked tasks", tasks !== undefined ? `${tasks} item${tasks === 1 ? "" : "s"}` : undefined);
    }
    case "note": {
      // manageNote { action: save|search|delete, text, query }
      const action = str(args.action)?.toLowerCase() ?? tool;
      const text = clip(str(args.text) ?? str(args.content));
      if (/(delete|remove)/.test(action)) return "Note deleted";
      if (/(add|create|save|new|take)/.test(action)) return join("Note saved", text);
      if (/(update|edit|change)/.test(action)) return join("Note updated", text);
      return join("Searched notes", str(args.q) ?? str(args.query));
    }
    case "budget":
      if (/(delete|remove)/.test(tool)) return join("Removed budget", category);
      if (/(set|upsert|create|update)/.test(tool)) return join("Budget set", category, money && `${money}/mo`);
      return "Checked budgets";
    case "reminder":
      if (/(delete|remove)/.test(tool)) {
        // deleteReminder → { deleted: "<reminder text>" }
        const deleted = a.result && typeof a.result === "object" ? (a.result as Record<string, unknown>).deleted : undefined;
        return join("Reminder deleted", clip(str(deleted) ?? str(a.args.query)));
      }
      if (/(done|complete)/.test(tool)) return "Reminder done";
      if (/(add|create|set)/.test(tool)) return join("Reminder set", clip(str(args.text)));
      return "Checked reminders";
    case "memory":
      return join("Remembered", clip(str(args.fact) ?? str(args.text)));
    case "income": {
      // manageIncome { action: add|list|summary|delete } → { income } | { income[] } | { totalReceived, … } | { deleted }
      const r = (a.result && typeof a.result === "object" ? a.result : {}) as Record<string, unknown>;
      const action = str(args.action)?.toLowerCase() ?? tool;
      if (/(delete|remove)/.test(action)) {
        const d = pick(r, "deleted");
        const amt = num(d.amount) ?? amount;
        return join(`Deleted ${amt !== undefined ? formatMoney(amt, currency) : "income"}`, str(d.payer) ?? str(args.payer));
      }
      if (/(add|create|log|record)/.test(action)) return join(`Received ${money ?? "income"}`, category, str(args.payer));
      if (/(summary|total)/.test(action)) {
        const total = num(r.totalReceived);
        return join("Checked income", total !== undefined ? formatMoney(total, currency) : undefined);
      }
      return "Looked up income";
    }
    case "money": {
      // getMoneyOverview { view: "balance" | "trends", months? } → a Ledger-like or TrendsResult-like object.
      const r = (a.result && typeof a.result === "object" ? a.result : {}) as Record<string, unknown>;
      const view = str(a.args.view)?.toLowerCase() ?? (/trend/.test(tool) ? "trends" : "balance");
      if (view === "trends") {
        const t = pick(r, "trends");
        const change = num(t.spentChangePercent);
        const months = num(a.args.months) ?? (Array.isArray(t.months) ? t.months.length : undefined);
        return join(
          "Checked trends",
          months !== undefined ? `${months} months` : undefined,
          change !== undefined ? `${change > 0 ? "+" : change < 0 ? "−" : ""}${Math.abs(Math.round(change))}% spending` : undefined,
        );
      }
      const l = pick(r, "ledger");
      const totals = (l.totals && typeof l.totals === "object" ? l.totals : l) as Record<string, unknown>;
      const balance = num(totals.balance);
      return join("Balance", balance !== undefined ? formatMoney(balance, currency) : undefined);
    }
    case "expense":
      if (/(add|create|log|record)/.test(tool)) return join(`Added ${money ?? "expense"}`, category, merchant);
      if (/(delete|remove)/.test(tool)) return join(`Deleted ${money ?? "expense"}`, category);
      if (/(update|edit|change)/.test(tool)) return join("Updated expense", money, category);
      if (/(summary|total|spend|stat)/.test(tool)) return "Checked spending";
      return "Looked up expenses";
    default:
      // Unknown tool: a readable version of its name.
      return humanize(a.tool).replace(/^./, (c) => c.toUpperCase());
  }
}

/** "getSpendingSummary" / "get_spending_summary" → "get spending summary". */
function humanize(name: string) {
  return name.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

