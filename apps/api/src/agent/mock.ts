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

// ---------- personal-assistant phrases (tasks, notes, weather, briefings) ----------

const splitItems = (s: string) =>
  s
    .split(/\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*/)
    .map((x) => x.replace(/^(some|a|an|the)\s+/, "").trim())
    .filter(Boolean);

function listName(raw: string): string {
  const s = raw.replace(/^(my|the|our)\s+/, "").replace(/\s*list$/, "").trim();
  if (!s || /^(to ?-?do'?s?|tasks?)$/.test(s)) return "Inbox";
  return titleCase(s);
}

/** Pull "today"/"tomorrow"/"on friday" out of a task title. */
function taskDue(text: string, ctx: LlmContext): { rest: string; dueDate?: string } {
  const td = today(ctx);
  let rest = text;
  let dueDate: string | undefined;
  const take = (re: RegExp, f: (m: RegExpExecArray) => string) => {
    const m = re.exec(rest);
    if (m) {
      dueDate = f(m);
      rest = (rest.slice(0, m.index) + rest.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim();
    }
  };
  take(/\b(?:by |for |due )?tomorrow\b/, () => addDays(td, 1));
  if (!dueDate) take(/\b(?:by |for |due )?(?:today|tonight)\b/, () => td);
  if (!dueDate) {
    take(new RegExp(`\\b(?:by |on |due |this |next )?(${WEEKDAYS.join("|")})\\b`), (m) => {
      let diff = (WEEKDAYS.indexOf(m[1]) - zonedParts(ctx.now, ctx.timezone).weekday + 7) % 7;
      if (diff === 0) diff = 7;
      return addDays(td, diff);
    });
  }
  return { rest, dueDate };
}

function planAssistant(t: string, ctx: LlmContext, original: string): Plan | undefined {
  // weather
  if (/\b(weather|temperature|forecast|raining|rain|umbrella|humid|sunny|how hot|how cold)\b/.test(t) && !/\b(spent|paid)\b/.test(t)) {
    const city = /\bin ([a-z][a-z .-]*?)(?:\s+(?:today|tomorrow|tonight|right now|now|this week))?$/.exec(t)?.[1];
    return { tool: "getWeather", args: { ...(city ? { city: titleCase(city) } : {}), ...(/\btomorrow\b/.test(t) ? { day: "tomorrow" } : {}) } };
  }
  // briefings
  if (/\b(weekly (report|summary|recap|review)|week'?s? (report|recap|review)|how did i do last week|last week'?s? (report|summary|recap))\b/.test(t)) {
    return { tool: "getWeeklyReport", args: {} };
  }
  if (/\b(brief me|briefing|my day look|what'?s (on )?(for )?today|plan for today|morning update|daily (summary|update))\b/.test(t)) {
    return { tool: "getDailyBriefing", args: {} };
  }

  // notes
  // Match on the original text so the note keeps the user's casing ("B2-47").
  const raw = original.replace(/[’]/g, "'").replace(/\s+/g, " ").trim().replace(/[.!]+$/, "");
  const saveNote =
    /^(?:please )?(?:take|make|save|add|write|create)(?: a| this)? note(?: that| saying| to say| of|:|,)?\s+(.+)$/i.exec(raw) ??
    /^(?:note|jot down)(?: that|:|,)?\s+(.+)$/i.exec(raw);
  if (saveNote) return { tool: "manageNote", args: { action: "save", text: saveNote[1] } };
  if (/\bnotes?\b/.test(t)) {
    if (/\b(delete|remove|erase)\b/.test(t)) return { tool: "manageNote", args: { action: "delete", query: t } };
    if (/\b(what|find|search|show|read|look up|where|which|tell)\b/.test(t)) return { tool: "manageNote", args: { action: "search", query: t } };
  }

  // tasks: add
  const addToList = /^(?:please )?(?:add|put)\s+(.+?)\s+(?:to|on|in)\s+(?:my |the )?([a-z -]*?)\s*list$/.exec(t);
  if (addToList) {
    const { rest, dueDate } = taskDue(addToList[1], ctx);
    return { tool: "manageTask", args: { action: "add", titles: splitItems(rest), list: listName(addToList[2]), ...(dueDate ? { dueDate } : {}) } };
  }
  const addTask = /^(?:please )?(?:add|create|new)\s+(?:a\s+)?(?:task|to-?do)\s*(?:to\s+|:\s*|,\s*)?(.+)$/.exec(t);
  if (addTask) {
    const { rest, dueDate } = taskDue(addTask[1], ctx);
    return { tool: "manageTask", args: { action: "add", titles: [rest], ...(dueDate ? { dueDate } : {}) } };
  }
  // tasks: delete
  const delFromList = /\b(?:delete|remove|take)\s+(.+?)\s+(?:from|off)\s+(?:my |the )?([a-z -]*?)\s*list$/.exec(t);
  if (delFromList) return { tool: "manageTask", args: { action: "delete", titles: splitItems(delFromList[1]), list: listName(delFromList[2]) } };
  const delTask = /\b(?:delete|remove)\s+(?:the\s+)?(?:task|to-?do)\s+(.+)$/.exec(t);
  if (delTask) return { tool: "manageTask", args: { action: "delete", titles: [delTask[1]] } };
  // tasks: complete
  const done =
    /^(?:please )?(?:mark|tick(?: off)?|check off|cross off)\s+(.+?)(?:\s+as)?(?:\s+(?:done|complete|completed|finished))?(?:\s+off)?$/.exec(t) ??
    /^(?:complete|finish)\s+(?:the\s+)?(?:task\s+)?(.+)$/.exec(t) ??
    /^(?:i(?: have|'ve)?\s+)?(?:done with|finished|completed)\s+(.+)$/.exec(t) ??
    /^(.+?)\s+is\s+(?:done|finished|complete)$/.exec(t);
  if (done && !parseAmount(t)) {
    const fromList = /\s+(?:from|on|in)\s+(?:my |the )?([a-z -]*?)\s*list$/.exec(done[1]);
    const items = fromList ? done[1].slice(0, fromList.index) : done[1];
    return {
      tool: "manageTask",
      args: { action: "complete", titles: splitItems(items.replace(/^(?:the\s+)?task\s+/, "")), ...(fromList ? { list: listName(fromList[1]) } : {}) },
    };
  }
  // tasks: list
  const namedList = /\b(?:my|the) ([a-z -]+?) list\b/.exec(t);
  if (namedList && /\b(what|show|read|list|anything|what's|whats|tell|check)\b/.test(t)) {
    const name = listName(namedList[1]);
    return { tool: "manageTask", args: { action: "list", ...(name === "Inbox" && !/to ?-?do/.test(namedList[1]) ? {} : { list: name }) } };
  }
  if (/\b(tasks?|to-?dos?|to do list)\b/.test(t)) {
    if (/\boverdue\b/.test(t)) return { tool: "manageTask", args: { action: "list", when: "overdue" } };
    if (/\b(today|due)\b/.test(t)) return { tool: "manageTask", args: { action: "list", when: "today" } };
    return { tool: "manageTask", args: { action: "list" } };
  }
  if (/\bwhat'?s overdue\b/.test(t)) return { tool: "manageTask", args: { action: "list", when: "overdue" } };
  return undefined;
}

/** Canned answers for a few everyday questions (the real LLM answers these from its own knowledge). */
function generalAnswer(t: string): string | undefined {
  if (/\bgrams?\b.*\bcup\b|\bcup\b.*\bgrams?\b/.test(t)) {
    return "One cup is about 240 millilitres. That's roughly 120 grams of flour, 200 grams of sugar, or 240 grams of water.";
  }
  if (/\b(workout|exercise routine|exercises)\b/.test(t)) {
    return "Try this 10 minute workout: one minute each of jumping jacks, squats, push-ups, lunges and plank, then repeat the round once.";
  }
  if (/\bplan my (evening|night)\b/.test(t)) {
    return "How about a short walk first, then dinner, an hour for something you enjoy, and lights out by eleven. Want me to add any of that as tasks?";
  }
  return undefined;
}

// ---------- intent → tool calls ----------

type Plan = { tool: string; args: Record<string, unknown> } | { reply: string };

const INCOME_RE = /\b(received|receive|got paid|credited|incoming|salary|earned|refund(ed)?|cashback|reimbursed)\b|\b(gave|paid|sent|transferred) me\b/;
const INCOME_QUERY_RE = /\bhow much\b.*\b(received|receive|earned|earn|income|got paid)\b|\b(my|total) income\b/;

/** "Received 75k salary", "Ravi gave me 500", "500 credited from Acme" → manageIncome add. */
export function parseIncome(t: string, ctx: LlmContext): Plan | undefined {
  if (!INCOME_RE.test(t)) return undefined;
  const amount = parseAmount(t);
  if (!amount) return { reply: "How much did you receive?" };
  const payerAfter = phraseAfter(t, ["from", "by"]);
  const payerBefore = /^(?:my )?([a-z][a-z ]{0,30}?) (?:gave|paid|sent|transferred) me\b/.exec(t)?.[1];
  const payer = payerAfter ?? (payerBefore && !/^(i|someone|somebody)$/.test(payerBefore) ? payerBefore : undefined);
  const category = /\bsalary|paycheck|wages\b/.test(t)
    ? "Salary"
    : /\b(refund(ed)?|cashback|reimburs\w*)\b/.test(t)
      ? "Refund"
      : /\b(gift|birthday)\b/.test(t)
        ? "Gift"
        : /\binterest|dividend\b/.test(t)
          ? "Interest"
          : "Other";
  const note = phraseAfter(t, ["for"]);
  const date = parseDay(t, ctx);
  return {
    tool: "manageIncome",
    args: {
      action: "add",
      amount,
      category,
      ...(payer ? { payer: titleCase(payer) } : {}),
      ...(note ? { note } : {}),
      ...(date && date !== today(ctx) ? { date } : {}),
    },
  };
}

export function planFor(message: string, ctx: LlmContext): Plan {
  const t = norm(message).replace(/[?!.]+$/, "");

  if (/^(hi|hello|hey|namaste|yo|good (morning|afternoon|evening))\b/.test(t) && t.split(" ").length <= 4) {
    return { reply: `Hi ${ctx.userName}, I'm ${ctx.assistantName}. Tell me what you spent, or ask how your budget is doing.` };
  }
  if (/\b(thank you|thanks|thx|shukriya|dhanyavaad)\b/.test(t)) return { reply: "You're welcome." };
  if (/\b(what can you do|help me|how do i use|what do you do)\b/.test(t) || t === "help") {
    return {
      reply:
        "I can log expenses and budgets, keep your to-do lists and notes, set reminders, check the weather and brief you on your day. Try saying, add milk and eggs to my shopping list.",
    };
  }
  if (/\bwhat('s| is) my name\b|\bwho am i\b/.test(t)) return { reply: `You're ${ctx.userName}.` };
  if (/\bwhat('s| is) your name\b|\bwho are you\b/.test(t)) return { reply: `I'm ${ctx.assistantName}, your personal assistant.` };
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

  const assistant = planAssistant(t, ctx, message);
  if (assistant) return assistant;

  // memory
  const forget = /^(?:please )?forget (?:that |about )?(.+)$/.exec(t);
  if (forget && !/^(it|that|this)$/.test(forget[1])) return { tool: "manageMemory", args: { action: "forget", query: forget[1] } };
  if (/\b(list|show|what are) (my |the )?(memories|facts)\b/.test(t)) return { tool: "manageMemory", args: { action: "list" } };
  const rem = /\bremember (?:that )?(.+)/.exec(t);
  if (rem) return { tool: "manageMemory", args: { action: "save", fact: rem[1] } };

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
    if (/\b(income|salary|received|credit(ed)?)\b/.test(t)) {
      const amount = parseAmount(t);
      return { tool: "manageIncome", args: { action: "delete", ...(amount ? { amount } : {}) } };
    }
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

  // income (before spending queries: "how much did I receive" is not spending)
  if (INCOME_QUERY_RE.test(t)) {
    const period = parsePeriod(t, ctx);
    return { tool: "manageIncome", args: { action: "summary", ...(period.from ? { from: period.from, to: period.to } : {}) } };
  }
  const income = parseIncome(t, ctx);
  if (income) return income;

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

  const general = generalAnswer(t);
  if (general) return { reply: general };
  if (/^(what|how|why|who|when|where|can|could|should|is|are|do|does|give|tell|suggest|recommend|explain)\b/.test(t)) {
    return {
      reply:
        "I can answer general questions once my language model is connected. Right now I can help with expenses, tasks, notes, reminders and the weather.",
    };
  }

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
    case "manageIncome": {
      if (result.income && !Array.isArray(result.income)) {
        const i = result.income as Json;
        const from = i.payer ? ` from ${i.payer}` : i.note ? ` for ${i.note}` : "";
        return `Got it, ${money(i.amount)} received${from}, logged as ${i.category} income.`;
      }
      if (Array.isArray(result.income)) {
        const list = result.income as Json[];
        if (!list.length) return "You haven't logged any income yet.";
        return `Your latest income: ${joinList(list.slice(0, 3).map((i) => `${money(i.amount)}${i.payer ? ` from ${i.payer}` : ""}`))}.`;
      }
      const label = parsePeriod(userText, ctx).label;
      if (!result.count) return `You haven't logged any income ${label}.`;
      return `You've received ${money(result.totalReceived)} ${label}, across ${result.count} payment${result.count === 1 ? "" : "s"}.`;
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
    case "manageMemory": {
      if (result.saved) return "Got it, I'll remember that.";
      if (result.forgotten) return `Okay, I've forgotten that ${result.forgotten}.`;
      const facts = (result.facts ?? []) as string[];
      return facts.length ? `Here's what I remember: ${facts.slice(0, 5).join(". ")}.` : "I don't have any saved facts about you yet.";
    }
    case "manageTask": {
      if (result.added) {
        const due = result.due ? ` for ${speakDay(zonedToUtc(...(result.due.split("-").map(Number) as [number, number, number]), 12, 0, 0, ctx.timezone), ctx.timezone, ctx.now).replace(/^on /, "")}` : "";
        return result.list === "Inbox"
          ? `Added ${joinList(result.added)} to your tasks${due}.`
          : `Added ${joinList(result.added)} to your ${result.list} list${due}.`;
      }
      if (result.completed) {
        let s = `Nice, I've marked ${joinList(result.completed)} as done.`;
        if (result.notFound?.length) s += ` I couldn't find ${joinList(result.notFound)}.`;
        return s;
      }
      if (result.deleted) return `Deleted ${joinList(result.deleted)}.`;
      if (result.tasks) {
        const items = (result.tasks as Json[]).slice(0, 6).map((x) => x.title as string);
        const more = result.count > items.length ? ` and ${result.count - items.length} more` : "";
        const where = result.list ? (result.list === "Inbox" ? "Your task list" : `Your ${result.list} list`) : null;
        if (!result.count) {
          if (result.when === "today") return "Nothing is due today.";
          if (result.when === "overdue") return "Nothing is overdue.";
          return where ? `${where} is empty.` : "You have no open tasks.";
        }
        const n = `${result.count} ${result.count === 1 ? "item" : "items"}`;
        if (result.when === "today") return `You have ${result.count} ${result.count === 1 ? "task" : "tasks"} due: ${joinList(items)}${more}.`;
        if (result.when === "overdue") return `${result.count} ${result.count === 1 ? "task is" : "tasks are"} overdue: ${joinList(items)}${more}.`;
        return `${where ?? "You have"} ${where ? "has " : ""}${n}${where ? "" : " open"}: ${more ? items.join(", ") + more : joinList(items)}.`;
      }
      return "Done.";
    }
    case "manageNote": {
      if (result.saved) return "Saved your note.";
      if (result.deleted) return "Deleted that note.";
      const list = (result.notes ?? []) as Json[];
      if (!list.length) return "I couldn't find a note about that.";
      return `Your note says: ${list[0].text}`;
    }
    case "getWeather": {
      if (result.day === "tomorrow") {
        return `Tomorrow in ${result.city}: ${String(result.condition).toLowerCase()}, ${result.lowC} to ${result.highC} degrees, with a ${result.rainChance}% chance of rain.`;
      }
      const rain = result.today.rainChance >= 30 ? ` and a ${result.today.rainChance}% chance of rain` : "";
      return `In ${result.city} it's ${result.now.tempC} degrees and ${String(result.now.condition).toLowerCase()}, with a high of ${result.today.highC}${rain}.`;
    }
    case "getDailyBriefing":
      return String(result.briefing);
    case "getWeeklyReport":
      return String(result.report);
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
