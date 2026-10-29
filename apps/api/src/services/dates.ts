/** Timezone helpers built on Intl (no external deps). */

export type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number };

/** Max cached formatters. Keys are canonical IANA names only, so this is a safety cap, not an LRU. */
export const FMT_CACHE_MAX = 64;
const fmtCache = new Map<string, Intl.DateTimeFormat>();

/** Test hook. */
export const fmtCacheSize = () => fmtCache.size;

/**
 * Canonical IANA name ("aSiA/kOlKaTa" -> "Asia/Kolkata"), or undefined if invalid. Intl accepts any
 * casing, so caching by the raw string would let callers grow the cache without bound.
 */
export function canonicalTimezone(tz: string | undefined): string | undefined {
  if (!tz || tz.length > 64) return undefined;
  try {
    const id = new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
    return MODERN_ZONE_NAMES[id] ?? id;
  } catch {
    return undefined;
  }
}

/** ICU still canonicalises some zones to their legacy names; prefer the current IANA spelling. */
const MODERN_ZONE_NAMES: Record<string, string> = {
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Asia/Rangoon": "Asia/Yangon",
  "Europe/Kiev": "Europe/Kyiv",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "America/Godthab": "America/Nuuk",
};

function fmt(tz: string) {
  let f = fmtCache.get(tz);
  if (f) return f;
  const canonical = canonicalTimezone(tz);
  if (!canonical) throw new RangeError(`Invalid time zone: ${tz}`);
  f = fmtCache.get(canonical);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: canonical,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    if (fmtCache.size >= FMT_CACHE_MAX) fmtCache.delete(fmtCache.keys().next().value!);
    fmtCache.set(canonical, f);
  }
  return f;
}

export function isValidTimezone(tz: string | undefined): tz is string {
  return canonicalTimezone(tz) !== undefined;
}

/** Always returns a canonical IANA name (safe to cache by and to pass to Mongo $dateToString). */
export function resolveTimezone(tz: string | undefined, fallback = "Asia/Kolkata"): string {
  return canonicalTimezone(tz) ?? canonicalTimezone(fallback) ?? "UTC";
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
