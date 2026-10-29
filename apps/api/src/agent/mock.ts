/**
 * Deterministic rule-based "LLM" used when no API key is configured (and in all tests).
 * It speaks the same protocol as a real provider: given the conversation it either emits
 * tool calls (for the last user message) or composes a final reply from tool results.
 */
import type { Category } from "@nova/shared";
import { CATEGORIES } from "@nova/shared";
import { addDays, localDateString, pad, zonedParts, zonedToUtc } from "../services/dates";
import { formatMoney, speakDay, speakTime } from "./format";
import type { ChatMessage, ChatRequest, ChatResult, LlmClient, LlmContext, ToolCall } from "./llm";

// ---------- vocabulary ----------

const KEYWORDS: [Category, string[]][] = [
  ["Groceries", ["blinkit", "zepto", "bigbasket", "big basket", "instamart", "dmart", "d mart", "jiomart", "grocery", "groceries", "vegetables", "veggies", "milk", "fruits", "kirana", "supermarket"]],
  ["Transport", ["uber", "ola", "rapido", "metro", "auto", "rickshaw", "cab", "taxi", "bus", "petrol", "diesel", "fuel", "parking", "toll", "fastag", "commute", "transport"]],
  ["Shopping", ["amazon", "flipkart", "myntra", "ajio", "meesho", "nykaa", "clothes", "shoes", "shirt", "jeans", "shopping", "gadget", "headphones"]],
  ["Rent", ["rent", "landlord"]],
  ["Bills", ["electricity", "water bill", "wifi", "wi-fi", "internet", "broadband", "recharge", "mobile bill", "phone bill", "gas bill", "cylinder", "dth", "jio", "airtel", "bill", "bills", "emi", "insurance"]],
  ["Entertainment", ["netflix", "prime video", "hotstar", "spotify", "movie", "movies", "pvr", "inox", "bookmyshow", "concert", "gaming", "game", "entertainment"]],
  ["Health", ["doctor", "hospital", "pharmacy", "medicine", "medicines", "apollo", "pharmeasy", "1mg", "gym", "clinic", "dentist", "health", "medical"]],
  ["Education", ["course", "udemy", "coursera", "book", "books", "tuition", "school", "college", "fees", "exam", "education"]],
  ["Travel", ["flight", "hotel", "train", "irctc", "makemytrip", "goibibo", "airbnb", "indigo", "trip", "vacation", "holiday", "travel"]],
  ["Food", ["swiggy", "zomato", "dominos", "domino's", "mcdonalds", "mcdonald's", "kfc", "starbucks", "eatsure", "lunch", "dinner", "breakfast", "brunch", "coffee", "tea", "chai", "snacks", "snack", "food", "restaurant", "cafe", "pizza", "burger", "biryani", "dosa", "juice", "meal"]],
];

const KNOWN_MERCHANTS = new Set([
  "swiggy", "zomato", "dominos", "mcdonalds", "kfc", "starbucks", "uber", "ola", "rapido", "amazon", "flipkart", "myntra",
  "ajio", "meesho", "nykaa", "blinkit", "zepto", "bigbasket", "instamart", "dmart", "jiomart", "netflix", "hotstar", "spotify",
  "pvr", "inox", "bookmyshow", "apollo", "pharmeasy", "udemy", "coursera", "irctc", "makemytrip", "goibibo", "airbnb", "indigo",
  "jio", "airtel",
]);

const STOP = new Set([
  "yesterday", "today", "tonight", "tomorrow", "last", "this", "on", "for", "at", "from", "with", "and", "via", "using", "by",
  "in", "ago", "morning", "evening", "afternoon", "night", "the", "day", "before", "rs", "rupees", "please", "using",
]);

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

// ---------- parsing helpers ----------

const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim();
const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());
const today = (ctx: LlmContext) => localDateString(ctx.now, ctx.timezone);

export function parseAmount(text: string): number | undefined {
  const m = /(?:₹|rs\.?|inr)?\s*(\d{1,3}(?:,\d{2,3})+|\d+(?:\.\d+)?)\s*(k|thousand|lakh|lakhs)?\b/i.exec(
    // ignore ordinal days ("5th") and clock times ("6pm") when looking for money
    text.replace(/\b\d{1,2}(st|nd|rd|th)\b/gi, " ").replace(/\b\d{1,2}(:\d{2})?\s*(am|pm)\b/gi, " "),
  );
  if (!m) return undefined;
  let n = Number(m[1].replace(/,/g, ""));
  const mult = m[2]?.toLowerCase();
  if (mult === "k" || mult === "thousand") n *= 1000;
  if (mult === "lakh" || mult === "lakhs") n *= 100000;
  return n > 0 ? n : undefined;
}

export function categoryFromText(text: string): Category | undefined {
  const t = ` ${norm(text)} `;
  for (const c of CATEGORIES) if (t.includes(` ${c.toLowerCase()} `)) return c;
  if (/\bgrocer/.test(t)) return "Groceries";
  for (const [cat, words] of KEYWORDS) {
    if (words.some((w) => new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`).test(t))) return cat;
  }
  return undefined;
}

/** Capture up to 3 words after `prep` until a stop word / number. */
function phraseAfter(text: string, preps: string[]): string | undefined {
  const words = norm(text).replace(/[,.!?]/g, " ").split(" ").filter(Boolean);
  for (let i = 0; i < words.length - 1; i++) {
    if (!preps.includes(words[i])) continue;
    const out: string[] = [];
    for (let j = i + 1; j < words.length && out.length < 3; j++) {
      const w = words[j];
      if (STOP.has(w) || /^[₹\d]/.test(w)) break;
      if (["my", "a", "an", "some"].includes(w) && out.length === 0) continue;
      out.push(w);
    }
    if (out.length) return out.join(" ");
  }
  return undefined;
}

/** Resolve a spoken day reference to YYYY-MM-DD (past-leaning, for expenses). */
export function parseDay(text: string, ctx: LlmContext): string | undefined {
  const t = norm(text);
  const td = today(ctx);
  if (/\bday before yesterday\b/.test(t)) return addDays(td, -2);
  if (/\byesterday\b/.test(t)) return addDays(td, -1);
  if (/\b(today|tonight|this morning|this evening)\b/.test(t)) return td;
  const ago = /\b(\d+|a|one|two|three) days? ago\b/.exec(t);
  if (ago) {
    const n = { a: 1, one: 1, two: 2, three: 3 }[ago[1] as "a"] ?? Number(ago[1]);
    return addDays(td, -n);
  }
  const wd = new RegExp(`\\b(?:last|on)\\s+(${WEEKDAYS.join("|")})\\b`).exec(t);
  if (wd) {
    const target = WEEKDAYS.indexOf(wd[1]);
    const cur = zonedParts(ctx.now, ctx.timezone).weekday;
    let diff = (cur - target + 7) % 7;
    if (diff === 0) diff = 7;
    return addDays(td, -diff);
  }
  const nth = /\bon (?:the )?(\d{1,2})(?:st|nd|rd|th)?\b(?: of)?(?: (\w+))?/.exec(t);
  if (nth) {
    const day = Number(nth[1]);
    const p = zonedParts(ctx.now, ctx.timezone);
    const mIdx = nth[2] ? MONTHS.findIndex((m) => m.startsWith(nth[2].slice(0, 3))) : -1;
    let year = p.year;
    let month = mIdx >= 0 ? mIdx + 1 : p.month;
    if (mIdx < 0 && day > p.day) month -= 1; // "on the 28th" said on the 5th means last month
    if (month < 1) { month += 12; year -= 1; }
    if (mIdx >= 0 && month > p.month) year -= 1;
    if (day >= 1 && day <= 31) return `${year}-${pad(month)}-${pad(day)}`;
  }
  return undefined;
}

type Period = { from?: string; to?: string; label: string };

export function parsePeriod(text: string, ctx: LlmContext): Period {
  const t = norm(text);
  const td = today(ctx);
  const p = zonedParts(ctx.now, ctx.timezone);
  const monthStart = (y: number, m: number) => localDateString(zonedToUtc(y, m, 1, 12, 0, 0, ctx.timezone), ctx.timezone);
  const monthEnd = (y: number, m: number) => localDateString(zonedToUtc(y, m + 1, 0, 12, 0, 0, ctx.timezone), ctx.timezone);
  if (/\btoday\b/.test(t)) return { from: td, to: td, label: "today" };
  if (/\byesterday\b/.test(t)) return { from: addDays(td, -1), to: addDays(td, -1), label: "yesterday" };
  if (/\blast week\b/.test(t)) {
    const mondayThis = addDays(td, -((p.weekday + 6) % 7));
    return { from: addDays(mondayThis, -7), to: addDays(mondayThis, -1), label: "last week" };
  }
  if (/\bthis week\b/.test(t)) return { from: addDays(td, -((p.weekday + 6) % 7)), to: td, label: "this week" };
  const lastN = /\b(?:last|past) (\d+) days\b/.exec(t);
  if (lastN) return { from: addDays(td, -(Number(lastN[1]) - 1)), to: td, label: `in the last ${lastN[1]} days` };
  if (/\blast month\b/.test(t)) {
    return { from: monthStart(p.year, p.month - 1), to: monthEnd(p.year, p.month - 1), label: "last month" };
  }
  const inMonth = new RegExp(`\\b(?:in|for|during) (${MONTHS.join("|")})\\b`).exec(t);
  if (inMonth) {
    const m = MONTHS.indexOf(inMonth[1]) + 1;
    const y = m > p.month ? p.year - 1 : p.year;
    return { from: monthStart(y, m), to: monthEnd(y, m), label: `in ${titleCase(inMonth[1])}` };
  }
  return { label: "this month" };
}

/** Resolve a reminder time to local "YYYY-MM-DDTHH:mm" plus cleaned reminder text. */
export function parseReminder(raw: string, ctx: LlmContext): { text: string; dateTime: string } {
  let t = norm(raw).replace(/^.*?\bremind me\b\s*(?:to|about|that)?\s*/, "");
  const p = zonedParts(ctx.now, ctx.timezone);
  const td = today(ctx);
  let date: string | undefined;
  let hour: number | undefined;
  let minute = 0;

  const strip = (re: RegExp) => {
    const m = re.exec(t);
    if (m) t = (t.slice(0, m.index) + " " + t.slice(m.index + m[0].length)).trim();
    return m;
  };

  const rel = strip(/\bin (\d+|an?|one) (minute|minutes|min|mins|hour|hours|day|days)\b/);
  if (rel) {
    const n = /^\d+$/.test(rel[1]) ? Number(rel[1]) : 1;
    const ms = rel[2].startsWith("min") ? n * 60_000 : rel[2].startsWith("hour") ? n * 3_600_000 : n * 86_400_000;
    const when = new Date(ctx.now.getTime() + ms);
    const wp = zonedParts(when, ctx.timezone);
    return {
      text: t.replace(/\s+/g, " ").trim() || "your reminder",
      dateTime: `${localDateString(when, ctx.timezone)}T${pad(wp.hour)}:${pad(wp.minute)}`,
    };
  }

  const time = strip(/\b(?:at )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/) ?? strip(/\bat (\d{1,2})(?::(\d{2}))?\b/);
  if (time) {
    hour = Number(time[1]) % 12;
    if (time[3] === "pm" || (!time[3] && hour < 8)) hour += 12; // "at 6" -> 6 PM
    if (time[3] === "am" && Number(time[1]) === 12) hour = 0;
    if (!time[3] && Number(time[1]) === 12) hour = 12;
    minute = time[2] ? Number(time[2]) : 0;
  }
  if (strip(/\bday after tomorrow\b/)) date = addDays(td, 2);
  else if (strip(/\btomorrow\b/)) date = addDays(td, 1);
  else if (strip(/\b(?:today|tonight|this evening)\b/)) date = td;
  const wd = strip(new RegExp(`\\b(?:on |next |this )?(${WEEKDAYS.join("|")})\\b`));
  if (wd) {
    let diff = (WEEKDAYS.indexOf(wd[1]) - p.weekday + 7) % 7;
    if (diff === 0) diff = 7;
    date = addDays(td, diff);
  }
  const nth = strip(/\bon (?:the )?(\d{1,2})(?:st|nd|rd|th)\b(?: of (?:every|each|the) month| of (\w+))?/) ?? strip(/\bon (?:the )?(\d{1,2})\b(?: of (\w+))?/);
  if (nth) {
    const day = Number(nth[1]);
    const mIdx = nth[2] ? MONTHS.findIndex((m) => m.startsWith(nth[2].slice(0, 3))) : -1;
    let year = p.year;
    let month = mIdx >= 0 ? mIdx + 1 : p.month;
    if (mIdx < 0 && day <= p.day) month += 1; // already passed this month -> next month
    if (mIdx >= 0 && (month < p.month || (month === p.month && day <= p.day))) year += 1;
    if (month > 12) { month -= 12; year += 1; }
    date = `${year}-${pad(month)}-${pad(day)}`;
  }
  if (!date) {
    if (hour !== undefined) {
      const passed = hour < p.hour || (hour === p.hour && minute <= p.minute);
      date = passed ? addDays(td, 1) : td;
    } else {
      date = addDays(td, 1);
    }
  }
  const text = t.replace(/\b(every month|each month)\b/, "").replace(/\s+/g, " ").replace(/[.!?]+$/, "").trim();
  return { text: text || "your reminder", dateTime: `${date}T${pad(hour ?? 9)}:${pad(minute)}` };
}

// ---------- intent → tool calls ----------

type Plan = { tool: string; args: Record<string, unknown> } | { reply: string };

export function planFor(message: string, ctx: LlmContext): Plan {
  const t = norm(message).replace(/[?!.]+$/, "");

  if (/^(hi|hello|hey|namaste|yo|good (morning|afternoon|evening))\b/.test(t) && t.split(" ").length <= 4) {
    return { reply: `Hi ${ctx.userName}, I'm ${ctx.assistantName}. Tell me what you spent, or ask how your budget is doing.` };
  }
  if (/\b(thank you|thanks|thx|shukriya|dhanyavaad)\b/.test(t)) return { reply: "You're welcome." };
  if (/\b(what can you do|help me|how do i use|what do you do)\b/.test(t) || t === "help") {
    return {
      reply:
        "I can log expenses, tell you what you've spent, manage budgets, set reminders and remember things about you. Try saying, spent 250 on lunch at Swiggy.",
    };
  }
  if (/\bwhat('s| is) my name\b|\bwho am i\b/.test(t)) return { reply: `You're ${ctx.userName}.` };
  if (/\bwhat('s| is) your name\b|\bwho are you\b/.test(t)) return { reply: `I'm ${ctx.assistantName}, your money assistant.` };
  if (/\bwhat do you (know|remember) about me\b/.test(t)) {
    return {
      reply: ctx.memories.length
        ? `Here's what I remember: ${ctx.memories.slice(0, 5).join(". ")}.`
        : "I don't know much about you yet. Tell me something and say remember.",
    };
  }

  // reminders (before expenses: "remind me to pay rent" contains "pay")
  if (/\bremind me\b/.test(t)) return { tool: "createReminder", args: parseReminder(message, ctx) };
  if (/\breminders?\b/.test(t) && /\b(what|show|list|any|my|upcoming|pending)\b/.test(t)) return { tool: "listReminders", args: {} };

  // memory
  const rem = /\bremember (?:that )?(.+)/.exec(t);
  if (rem) return { tool: "rememberFact", args: { fact: rem[1] } };

  // budgets
  if (/\bbudgets?\b/.test(t)) {
    const amount = parseAmount(t);
    const cat = categoryFromText(t.replace(/\bbudgets?\b/g, ""));
    if (amount && /\b(set|make|change|update|put|create|add|increase|raise|lower|reduce)\b|\bto\b/.test(t)) {
      if (!cat) return { reply: "Which category should that budget be for?" };
      return { tool: "setBudget", args: { category: cat, monthlyLimit: amount } };
    }
    if (cat && !amount && /\b(how much|left|remaining|how am i|status|used)\b/.test(t)) {
      return { tool: "getSpendingSummary", args: { category: cat } };
    }
    return { tool: "getBudgets", args: {} };
  }

  // delete / update (destructive -> server asks for confirmation)
  if (/\b(delete|remove|undo|erase|scratch)\b/.test(t)) {
    const merchant = phraseAfter(t, ["at", "from"]) ?? [...KNOWN_MERCHANTS].find((m) => new RegExp(`\\b${m}\\b`).test(t));
    const amount = parseAmount(t);
    const match = { ...(merchant ? { merchant } : {}), ...(amount ? { amount } : {}) };
    return { tool: "deleteExpense", args: Object.keys(match).length ? { match } : {} };
  }
  if (/\b(change|update|edit|correct|fix|make)\b/.test(t) && /\b(last|that|it|previous|latest|expense)\b/.test(t)) {
    const args: Record<string, unknown> = {};
    const toPart = /\bto (.+)$/.exec(t)?.[1] ?? "";
    const amount = parseAmount(toPart);
    if (amount) args.amount = amount;
    const cat = categoryFromText(toPart);
    if (cat && !amount) args.category = cat;
    if (!Object.keys(args).length) return { reply: "What should I change it to? You can say, change my last expense to 300." };
    return { tool: "updateExpense", args };
  }

  // queries
  if (/\b(recent|latest|last( \d+)?) (expenses?|transactions?|purchases?)\b|\b(show|list) (me )?my (expenses|transactions)\b|\bwhat did i (buy|spend on)\b/.test(t)) {
    const n = /\blast (\d+)\b/.exec(t);
    const cat = categoryFromText(t);
    return { tool: "listRecentExpenses", args: { limit: n ? Math.min(20, Number(n[1])) : 5, ...(cat ? { category: cat } : {}) } };
  }
  const amount = parseAmount(t);
  if (/\b(how much|total|spending|spent so far|expenses? (this|last))\b/.test(t) && !(amount && /\b(spent|paid)\b/.test(t) && !/\bhow much\b/.test(t))) {
    const period = parsePeriod(t, ctx);
    const cat = categoryFromText(t.replace(/\b(spending|spent|spend|total|expenses?)\b/g, ""));
    return {
      tool: "getSpendingSummary",
      args: { ...(period.from ? { from: period.from, to: period.to } : {}), ...(cat ? { category: cat } : {}) },
    };
  }

  // add expense
  if (amount && (/\b(spent|spend|paid|pay|bought|purchased|gave|cost|expense|add|added|for|on|at)\b/.test(t) || /^(₹|rs)/.test(t))) {
    let merchant = phraseAfter(t, ["at", "from", "to", "via"]);
    let note = phraseAfter(t, ["on", "for"]);
    if (!merchant && note && KNOWN_MERCHANTS.has(note.split(" ")[0])) {
      merchant = note;
      note = undefined;
    }
    if (!merchant) merchant = [...KNOWN_MERCHANTS].find((m) => new RegExp(`\\b${m}\\b`).test(t));
    const category = categoryFromText(`${merchant ?? ""} ${note ?? ""}`) ?? categoryFromText(t) ?? "Other";
    const date = parseDay(t, ctx);
    return {
      tool: "addExpense",
      args: {
        amount,
        category,
        ...(merchant ? { merchant: titleCase(merchant) } : {}),
        ...(note && note !== merchant ? { note } : {}),
        ...(date && date !== today(ctx) ? { date } : {}),
      },
    };
  }
  if (/\b(spent|paid|bought)\b/.test(t)) return { reply: "How much was it?" };

  return {
    reply: "Sorry, I didn't catch that. You can say things like, spent 250 on lunch at Swiggy, or how much did I spend this month.",
  };
}

// ---------- tool results → spoken reply ----------

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") return m.content;
  }
  return "";
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export function composeReply(name: string, result: Json, ctx: LlmContext, userText: string): string {
  const money = (n: number) => formatMoney(n, ctx.currency);
  if (result.error) return `Sorry, I couldn't do that. ${String(result.error)}`;
  switch (name) {
    case "addExpense": {
      const e = result.expense as Json;
      const where = e.merchant ? ` at ${e.merchant}` : e.note ? ` for ${e.note}` : "";
      const day = e.date === today(ctx) ? "" : ` ${speakDay(zonedToUtc(...(e.date.split("-").map(Number) as [number, number, number]), 12, 0, 0, ctx.timezone), ctx.timezone, ctx.now)}`;
      let s = `Added ${money(e.amount)}${where} under ${e.category}${day}.`;
      const b = result.budget as Json | null;
      if (b) {
        const pct = Math.round(b.percentUsed);
        if (pct > 100) s += ` Heads up, you're over your ${b.category} budget, at ${pct}% this month.`;
        else if (pct === 100) s += ` Heads up, you've used all of your ${b.category} budget this month.`;
        else if (pct >= 80) s += ` Heads up, you've used ${pct}% of your ${b.category} budget.`;
      }
      return s;
    }
    case "getSpendingSummary": {
      const label = parsePeriod(userText, ctx).label;
      const on = result.category ? ` on ${result.category}` : "";
      if (!result.count) return `You haven't spent anything${on} ${label}.`;
      let s = `You've spent ${money(result.total)}${on} ${label}, across ${result.count} expense${result.count === 1 ? "" : "s"}.`;
      if (!result.category && result.byCategory?.length > 1) {
        const top = result.byCategory[0];
        s += ` Your biggest category is ${top.category} at ${money(top.total)}.`;
      }
      if (result.budget) {
        s += ` That's ${Math.round(result.budget.percentUsed)}% of your ${money(result.budget.monthlyLimit)} budget.`;
      }
      return s;
    }
    case "listRecentExpenses": {
      const list = result.expenses as Json[];
      if (!list.length) return "You don't have any expenses yet.";
      const items = list.map((e) => {
        const where = e.merchant ? ` at ${e.merchant}` : e.note ? ` for ${e.note}` : ` on ${e.category}`;
        const d = zonedToUtc(...(e.date.split("-").map(Number) as [number, number, number]), 12, 0, 0, ctx.timezone);
        return `${money(e.amount)}${where} ${speakDay(d, ctx.timezone, ctx.now)}`;
      });
      return `Your last ${list.length === 1 ? "expense was" : `${list.length} expenses were`} ${joinList(items)}.`;
    }
    case "setBudget": {
      const b = result.budget as Json;
      return `Done. Your ${b.category} budget is ${money(b.monthlyLimit)} a month. You've used ${Math.round(b.percentUsed)}% so far.`;
    }
    case "getBudgets": {
      const list = result.budgets as Json[];
      if (!list.length) return "You haven't set any budgets yet. Try saying, set food budget to 5000.";
      const items = list.map((b) => `${b.category} ${money(b.spent)} of ${money(b.monthlyLimit)}`);
      return `This month: ${joinList(items)}.`;
    }
    case "createReminder": {
      const r = result.reminder as Json;
      return `Okay, I'll remind you to ${r.text} ${speakDay(r.dateTime, ctx.timezone, ctx.now)} at ${speakTime(r.dateTime, ctx.timezone)}.`;
    }
    case "listReminders": {
      const list = result.reminders as Json[];
      if (!list.length) return "You have no upcoming reminders.";
      const items = list.slice(0, 5).map((r) => `${r.text} ${speakDay(r.dateTime, ctx.timezone, ctx.now)}`);
      return `You have ${list.length} reminder${list.length === 1 ? "" : "s"}: ${joinList(items)}.`;
    }
    case "rememberFact":
      return "Got it, I'll remember that.";
    case "updateExpense":
      return "Done, I've updated it.";
    case "deleteExpense":
      return "Done, I've deleted it.";
    default:
      return "Done.";
  }
}

export function createMockLlm(): LlmClient {
  let seq = 0;
  return {
    provider: "mock",
    model: "rule-based",
    async chat({ messages, context }: ChatRequest): Promise<ChatResult> {
      const last = messages[messages.length - 1];
      if (last?.role === "tool") {
        // Compose from the tool results of the most recent assistant tool-call turn.
        let i = messages.length - 1;
        while (i >= 0 && messages[i].role === "tool") i--;
        const assistant = messages[i];
        const calls: ToolCall[] = assistant?.role === "assistant" ? (assistant.tool_calls ?? []) : [];
        const userText = lastUserText(messages);
        const parts = messages.slice(i + 1).map((m) => {
          const tm = m as Extract<ChatMessage, { role: "tool" }>;
          const call = calls.find((c) => c.id === tm.tool_call_id);
          let result: Json;
          try {
            result = JSON.parse(tm.content);
          } catch {
            result = { error: tm.content };
          }
          return composeReply(call?.function.name ?? "", result, context, userText);
        });
        return { content: parts.join(" "), toolCalls: [] };
      }
      const plan = planFor(last?.role === "user" ? last.content : "", context);
      if ("reply" in plan) return { content: plan.reply, toolCalls: [] };
      return {
        content: null,
        toolCalls: [
          { id: `call_mock_${++seq}`, type: "function", function: { name: plan.tool, arguments: JSON.stringify(plan.args) } },
        ],
      };
    },
  };
}
