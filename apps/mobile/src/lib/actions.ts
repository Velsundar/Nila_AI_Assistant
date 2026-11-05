import type Ionicons from "@expo/vector-icons/Ionicons";
import type { AgentAction } from "@nova/shared";

import { prettifyTool } from "./format";

type IconName = keyof typeof Ionicons.glyphMap;
export type ActionRoute = "/expenses" | "/today";
export type ActionChip = { label: string; icon: IconName; route?: ActionRoute };

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/**
 * Turns an agent tool call into a short chip ("Added to Shopping", "Note saved"), with the tab
 * it relates to. Tool names come from apps/api/src/agent/tools.ts; unknown tools get a generic
 * prettified chip (routed by a keyword guess), so new server tools never break the UI.
 */
export function describeAction(a: AgentAction): ActionChip {
  const args = obj(a.args);
  const result = obj(a.result);
  const action = str(args.action);
  switch (a.tool) {
    case "addExpense":
      return { label: "Expense added", icon: "add-circle-outline", route: "/expenses" };
    case "updateExpense":
      return { label: "Expense updated", icon: "create-outline", route: "/expenses" };
    case "deleteExpense":
      return { label: "Expense deleted", icon: "trash-outline", route: "/expenses" };
    case "listRecentExpenses":
      return { label: "Recent expenses", icon: "list-outline", route: "/expenses" };
    case "getSpendingSummary":
      return { label: "Spending summary", icon: "pie-chart-outline", route: "/expenses" };
    case "manageIncome":
      // Money received lives on the Expenses tab ("Money in"); any of these refreshes it.
      if (action === "add") return { label: "Income added", icon: "arrow-down-circle-outline", route: "/expenses" };
      if (action === "delete") return { label: "Income deleted", icon: "trash-outline", route: "/expenses" };
      if (action === "summary") return { label: "Income summary", icon: "wallet-outline", route: "/expenses" };
      return { label: "Recent income", icon: "list-outline", route: "/expenses" };
    case "setBudget":
      return { label: "Budget set", icon: "speedometer-outline", route: "/expenses" };
    case "getBudgets":
      return { label: "Budgets", icon: "speedometer-outline", route: "/expenses" };
    case "createReminder":
      return { label: "Reminder set", icon: "alarm-outline", route: "/today" };
    case "listReminders":
      return { label: "Reminders", icon: "alarm-outline", route: "/today" };
    case "manageTask": {
      const list = str(result.list) ?? str(args.list);
      if (action === "add") return { label: list ? `Added to ${list}` : "Task added", icon: "checkbox-outline", route: "/today" };
      if (action === "complete") return { label: "Task done", icon: "checkmark-done-outline", route: "/today" };
      if (action === "delete") return { label: "Task deleted", icon: "trash-outline", route: "/today" };
      return { label: list ? `${list} list` : "Tasks", icon: "list-outline", route: "/today" };
    }
    case "manageNote":
      if (action === "save") return { label: "Note saved", icon: "document-text-outline", route: "/today" };
      if (action === "delete") return { label: "Note deleted", icon: "trash-outline", route: "/today" };
      return { label: "Notes searched", icon: "search-outline", route: "/today" };
    case "getWeather": {
      const city = str(result.city) ?? str(args.city);
      return { label: city ? `Weather · ${city}` : "Weather", icon: "partly-sunny-outline", route: "/today" };
    }
    case "getDailyBriefing":
      return { label: "Daily briefing", icon: "sunny-outline", route: "/today" };
    case "getWeeklyReport":
      return { label: "Weekly report", icon: "bar-chart-outline", route: "/expenses" };
    case "rememberFact":
      return { label: "Remembered", icon: "bulb-outline" };
  }
  // Generic fallback for tools this build doesn't know about yet.
  const t = a.tool;
  const route: ActionRoute | undefined = /expense|income|budget|spend|summary|categor|report|receipt/i.test(t)
    ? "/expenses"
    : /task|todo|note|remind|brief|weather|list/i.test(t)
      ? "/today"
      : undefined;
  return { label: prettifyTool(t), icon: "flash-outline", route };
}
