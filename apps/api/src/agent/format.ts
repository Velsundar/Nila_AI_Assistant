import { addDays, localDateString } from "../services/dates";

export function formatMoney(n: number, currency = "INR"): string {
  if (currency === "INR") {
    return "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  }
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 2 }).format(n);
  } catch {
    return `${currency} ${n}`;
  }
}

/** "today" / "yesterday" / "tomorrow" / "on Monday, 3 November". */
export function speakDay(date: Date | string, tz: string, now = new Date()): string {
  const d = new Date(date);
  const ymd = localDateString(d, tz);
  const today = localDateString(now, tz);
  if (ymd === today) return "today";
  if (ymd === addDays(today, -1)) return "yesterday";
  if (ymd === addDays(today, 1)) return "tomorrow";
  const s = new Intl.DateTimeFormat("en-IN", { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(d);
  return `on ${s}`;
}

export function speakTime(date: Date | string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" })
    .format(new Date(date))
    .replace(":00", "");
}

/** Make LLM output safe for TTS: no markdown, no emojis, single paragraph. */
export function sanitizeForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // markdown links
    .replace(/[*_`#>~|]+/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\p{Extended_Pictographic}|️|‍/gu, "")
    .replace(/\bRs\.?\s?(?=\d)/gi, "₹")
    .replace(/\bINR\s?(?=\d)/g, "₹")
    .replace(/\s+/g, " ")
    .trim();
}
