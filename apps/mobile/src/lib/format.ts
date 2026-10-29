const formatters = new Map<string, Intl.NumberFormat>();

export function formatMoney(amount: number, currency = "INR"): string {
  try {
    let f = formatters.get(currency);
    if (!f) {
      f = new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 2 });
      formatters.set(currency, f);
    }
    return f.format(amount);
  } catch {
    const symbol = currency === "INR" ? "₹" : `${currency} `;
    return `${symbol}${amount.toFixed(2)}`;
  }
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const same = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, today)) return "Today";
  if (same(d, yesterday)) return "Yesterday";
  try {
    return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  } catch {
    return d.toDateString();
  }
}

export function monthLabel(date = new Date()): string {
  try {
    return date.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  } catch {
    return `${date.getMonth() + 1}/${date.getFullYear()}`;
  }
}

export function deviceTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/** "add_expense" -> "Add expense" */
export function prettifyTool(tool: string): string {
  const s = tool.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Local calendar date as "YYYY-MM-DD" (the strict date form the API accepts). */
export function localISODate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Parses "YYYY-MM-DD" as a *local* date (Date.parse would treat it as UTC midnight). */
export function parseLocalDate(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.slice(0, 10));
  if (m && s.length <= 10) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(s);
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Due-date label for a task: "Overdue · 28 Oct", "Today", "Tomorrow", "Mon 3 Nov". */
export function dueLabel(due: string | undefined): { text: string; tone: "overdue" | "today" | "future" } | null {
  if (!due) return null;
  const d = parseLocalDate(due);
  if (Number.isNaN(d.getTime())) return null;
  const today = localISODate();
  const day = localISODate(d);
  if (day < today) return { text: `Overdue · ${d.toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`, tone: "overdue" };
  if (day === today) return { text: "Today", tone: "today" };
  if (day === localISODate(addDays(new Date(), 1))) return { text: "Tomorrow", tone: "future" };
  return { text: d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" }), tone: "future" };
}

export function formatPercent(n: number): string {
  return `${n > 0 ? "+" : ""}${Math.round(n)}%`;
}
