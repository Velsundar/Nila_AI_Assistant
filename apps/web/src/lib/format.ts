const cache = new Map<string, Intl.NumberFormat>();

export function formatMoney(amount: number, currency = "INR", opts: { compact?: boolean } = {}) {
  const key = `${currency}:${opts.compact ? 1 : 0}`;
  let f = cache.get(key);
  if (!f) {
    try {
      f = new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency,
        maximumFractionDigits: opts.compact ? 0 : 2,
        minimumFractionDigits: 0,
        ...(opts.compact ? { notation: "compact" as const } : {}),
      });
    } catch {
      f = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
    }
    cache.set(key, f);
  }
  return f.format(amount);
}

/** "YYYY-MM" for a local Date. */
export function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** "YYYY-MM-DD" for a local Date. */
export function dayKey(d = new Date()) {
  return `${monthKey(d)}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Local-time bounds of a "YYYY-MM" month as ISO strings, plus its day count. */
export function monthRange(key: string) {
  const [y, m] = key.split("-").map(Number);
  const start = new Date(y, m - 1, 1);
  const end = new Date(y, m, 1, 0, 0, 0, -1);
  return { from: start.toISOString(), to: end.toISOString(), days: end.getDate(), year: y, month: m };
}

export function shiftMonth(key: string, delta: number) {
  const [y, m] = key.split("-").map(Number);
  return monthKey(new Date(y, m - 1 + delta, 1));
}

export function monthLabel(key: string) {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
}

export function shortDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

/** Local "YYYY-MM-DD" of an ISO string (or "" if invalid). */
export function localDayOf(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : dayKey(d);
}

/** "Today" / "Tomorrow" / "Yesterday" / "Overdue · 3 Oct" / "12 Nov" for a due date, plus its tone. */
export function dueLabel(iso: string, now = new Date()): { label: string; tone: "overdue" | "today" | "soon" | "later" } {
  const day = localDayOf(iso);
  const today = dayKey(now);
  const tomorrow = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  const yesterday = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  if (!day) return { label: iso, tone: "later" };
  if (day === today) return { label: "Today", tone: "today" };
  if (day === tomorrow) return { label: "Tomorrow", tone: "soon" };
  if (day < today) return { label: day === yesterday ? "Yesterday" : `Overdue · ${shortDate(iso)}`, tone: "overdue" };
  return { label: shortDate(iso), tone: "later" };
}

export function timeOf(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
}

/** "19 Oct – 25 Oct" for two YYYY-MM-DD keys (parsed as local dates). */
export function dayRangeLabel(from: string, to: string) {
  const f = (k: string) => {
    const [y, m, d] = k.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  };
  return `${f(from)} – ${f(to)}`;
}

export function timezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}
