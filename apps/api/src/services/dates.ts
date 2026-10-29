/** Timezone helpers built on Intl (no external deps). */

export type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number };

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTimezone(tz: string | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function resolveTimezone(tz: string | undefined, fallback = "Asia/Kolkata"): string {
  return isValidTimezone(tz) ? tz : fallback;
}

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function zonedParts(date: Date, tz: string): ZonedParts {
  const p: Record<string, string> = {};
  for (const part of fmt(tz).formatToParts(date)) p[part.type] = part.value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: WD.indexOf(p.weekday),
  };
}

function offsetMs(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Convert a wall-clock time in `tz` to a UTC Date. Month is 1-based; values may overflow (e.g. day 0). */
export function zonedToUtc(year: number, month: number, day: number, hour = 0, minute = 0, second = 0, tz: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  let result = guess - offsetMs(new Date(guess), tz);
  const second2 = guess - offsetMs(new Date(result), tz);
  if (second2 !== result) result = second2;
  return new Date(result);
}

export const pad = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DD" of `date` in `tz`. */
export function localDateString(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Add days to a "YYYY-MM-DD" string. */
export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function startOfDay(ymd: string, tz: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return zonedToUtc(y, m, d, 0, 0, 0, tz);
}

export function monthBounds(date: Date, tz: string, monthOffset = 0): { start: Date; end: Date } {
  const p = zonedParts(date, tz);
  const start = zonedToUtc(p.year, p.month + monthOffset, 1, 0, 0, 0, tz);
  const end = zonedToUtc(p.year, p.month + monthOffset + 1, 1, 0, 0, 0, tz);
  return { start, end }; // end is exclusive
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
export const isDateOnly = (s: string) => DATE_ONLY.test(s);

/**
 * Parse an expense date: "YYYY-MM-DD" becomes noon local time in `tz` (so it lands on the
 * right calendar day in any nearby zone); a full ISO datetime is used as-is.
 */
export function parseExpenseDate(s: string | undefined, tz: string, now = new Date()): Date {
  if (!s) return now;
  if (isDateOnly(s)) {
    const [y, m, d] = s.split("-").map(Number);
    return zonedToUtc(y, m, d, 12, 0, 0, tz);
  }
  return new Date(s);
}

/**
 * Resolve a [from, to) range. Date-only `from` = start of that local day; date-only `to` is
 * inclusive (end of that local day). Defaults to the current calendar month in `tz`.
 */
export function resolveRange(from: string | undefined, to: string | undefined, tz: string, now = new Date()) {
  const month = monthBounds(now, tz);
  const start = from ? (isDateOnly(from) ? startOfDay(from, tz) : new Date(from)) : month.start;
  let end = to ? (isDateOnly(to) ? startOfDay(addDays(to, 1), tz) : new Date(to)) : month.end;
  // "from" in the future with no "to": make it a 1-day window rather than an empty/negative one.
  if (!to && end <= start) end = new Date(start.getTime() + 24 * 3600 * 1000);
  return { start, end };
}
