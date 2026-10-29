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
