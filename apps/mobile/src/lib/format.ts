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
