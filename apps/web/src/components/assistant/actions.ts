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

/** Short human label for a tool the agent ran, e.g. "Added ₹250 · Food". */
export function describeAction(a: AgentAction, currency = "INR"): string {
  const tool = a.tool.toLowerCase();
  const args = { ...pick(a.result, tool.includes("budget") ? "budget" : tool.includes("remind") ? "reminder" : "expense"), ...a.args };
  const amount = num(args.amount) ?? num(args.monthlyLimit);
  const money = amount !== undefined ? formatMoney(amount, currency) : undefined;
  const category = str(args.category);
  const merchant = str(args.merchant);
  const join = (...p: (string | undefined)[]) => p.filter(Boolean).join(" · ");

  if (!a.ok) return `Couldn't ${humanize(a.tool)}${a.error ? `: ${a.error}` : ""}`;

  if (tool.includes("budget")) {
    if (/(delete|remove)/.test(tool)) return join("Removed budget", category);
    if (/(set|upsert|create|update)/.test(tool)) return join("Budget set", category, money && `${money}/mo`);
    return "Checked budgets";
  }
  if (tool.includes("remind")) {
    if (/(delete|remove)/.test(tool)) return "Reminder removed";
    if (/(done|complete)/.test(tool)) return "Reminder done";
    if (/(add|create|set)/.test(tool)) return join("Reminder set", str(args.text));
    return "Checked reminders";
  }
  if (/(remember|fact|memory)/.test(tool)) return join("Remembered", str(args.fact) ?? str(args.text));
  if (/(add|create|log|record)/.test(tool)) return join(`Added ${money ?? "expense"}`, category, merchant);
  if (/(delete|remove)/.test(tool)) return join(`Deleted ${money ?? "expense"}`, category);
  if (/(update|edit|change)/.test(tool)) return join("Updated expense", money, category);
  if (/(summary|total|spend|report|stat)/.test(tool)) return "Checked spending";
  if (/(list|search|find|get|recent)/.test(tool)) return "Looked up expenses";
  return humanize(a.tool);
}

/** "getSpendingSummary" / "get_spending_summary" → "get spending summary". */
function humanize(name: string) {
  return name.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

