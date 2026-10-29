/**
 * Daily briefing and weekly report. Numbers come from MongoDB aggregations and the spoken `text`
 * is template-based, so neither endpoint spends any LLM tokens.
 */
import { Types } from "mongoose";
import type { BudgetStatus, Category, DailyBriefing, Reminder, Task, Weather, WeeklyReport } from "@nova/shared";
import { CATEGORIES } from "@nova/shared";
import { ExpenseModel } from "../models/Expense";
import { ReminderModel } from "../models/Reminder";
import { HttpError } from "../errors";
import { formatMoney, speakTime } from "../agent/format";
import { addDays, localDateString, monthBounds, startOfDay, zonedParts } from "./dates";
import { listBudgets } from "./budgets";
import { listTasks } from "./tasks";
import { weatherForUser } from "./weather";
import { round2, toReminder } from "./serialize";

const oid = (id: string) => new Types.ObjectId(id);

type BriefingUser = {
  _id: { toString(): string };
  name: string;
  currency?: string | null;
  city?: string | null;
  cityLat?: number | null;
  cityLon?: number | null;
};

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "2026-10-20" -> "20 October". */
export function speakYmd(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "long" }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

// ---------- daily briefing ----------

export function briefingText(
  b: Omit<DailyBriefing, "text">,
  p: { name: string; currency: string; timezone: string; hour: number; now: Date },
): string {
  const money = (n: number) => formatMoney(n, p.currency);
  const greet = p.hour < 5 ? "Hi" : p.hour < 12 ? "Good morning" : p.hour < 17 ? "Good afternoon" : "Good evening";
  const parts = [`${greet}, ${p.name.split(" ")[0]}.`];
  if (b.weather) {
    const w = b.weather;
    parts.push(
      `In ${w.city} it's ${w.tempC} degrees and ${w.condition.toLowerCase()}, with a high of ${w.highC}` +
        (w.rainChance >= 30 ? ` and a ${w.rainChance}% chance of rain.` : "."),
    );
  }
  if (b.reminders.length) {
    const items = b.reminders.slice(0, 3).map((r) => `${r.text} at ${speakTime(r.dateTime, p.timezone)}`);
    parts.push(`You have ${plural(b.reminders.length, "reminder")} today: ${joinList(items)}.`);
  }
  if (b.tasksDue.length) {
    const todayStart = startOfDay(localDateString(p.now, p.timezone), p.timezone).getTime();
    const overdue = b.tasksDue.filter((t) => t.dueDate && new Date(t.dueDate).getTime() < todayStart).length;
    const items = b.tasksDue.slice(0, 3).map((t) => t.title);
    const more = b.tasksDue.length > 3 ? ` and ${b.tasksDue.length - 3} more` : "";
    parts.push(
      `${plural(b.tasksDue.length, "task")} ${b.tasksDue.length === 1 ? "is" : "are"} due${overdue ? `, ${overdue} of them overdue` : ""}: ${
        more ? items.join(", ") + more : joinList(items)
      }.`,
    );
  }
  if (!b.reminders.length && !b.tasksDue.length) parts.push("Nothing is due today.");
  parts.push(
    b.spentYesterday > 0
      ? `You spent ${money(b.spentYesterday)} yesterday and ${money(b.spentThisMonth)} so far this month.`
      : `You didn't log any spending yesterday, and you're at ${money(b.spentThisMonth)} this month.`,
  );
  const alerts = b.budgetAlerts.slice(0, 2).map((a) =>
    a.percentUsed >= 100 ? `you're over your ${a.category} budget` : `${a.category} is at ${Math.round(a.percentUsed)}% of its budget`,
  );
  if (alerts.length) parts.push(`Heads up, ${joinList(alerts)}.`);
  return parts.join(" ");
}

export async function buildDailyBriefing(user: BriefingUser, tz: string, now = new Date()): Promise<DailyBriefing> {
  const userId = user._id.toString();
  const today = localDateString(now, tz);
  const dayStart = startOfDay(today, tz);
  const dayEnd = startOfDay(addDays(today, 1), tz);
  const yStart = startOfDay(addDays(today, -1), tz);
  const month = monthBounds(now, tz);

  const [reminderDocs, tasksDue, spend, budgets, weather] = await Promise.all([
    ReminderModel.find({ userId: oid(userId), done: false, dateTime: { $gte: dayStart, $lt: dayEnd } })
      .sort({ dateTime: 1 })
      .lean(),
    listTasks(userId, { when: "today" }, tz, now),
    ExpenseModel.aggregate<{ yesterday: { t: number }[]; month: { t: number }[] }>([
      { $match: { userId: oid(userId), date: { $gte: yStart < month.start ? yStart : month.start, $lt: month.end } } },
      {
        $facet: {
          yesterday: [{ $match: { date: { $gte: yStart, $lt: dayStart } } }, { $group: { _id: null, t: { $sum: "$amount" } } }],
          month: [{ $match: { date: { $gte: month.start, $lt: month.end } } }, { $group: { _id: null, t: { $sum: "$amount" } } }],
        },
      },
    ]),
    listBudgets(userId, tz),
    weatherForUser(user),
  ]);

  const reminders: Reminder[] = reminderDocs.map(toReminder);
  const base: Omit<DailyBriefing, "text"> = {
    date: today,
    ...(weather ? { weather: weather as Weather } : {}),
    reminders,
    tasksDue: tasksDue as Task[],
    spentYesterday: round2(spend[0]?.yesterday[0]?.t ?? 0),
    spentThisMonth: round2(spend[0]?.month[0]?.t ?? 0),
    budgetAlerts: budgets.filter((b: BudgetStatus) => b.percentUsed >= 80).sort((a, b) => b.percentUsed - a.percentUsed),
  };
  const text = briefingText(base, {
    name: user.name,
    currency: user.currency || "INR",
    timezone: tz,
    hour: zonedParts(now, tz).hour,
    now,
  });
  return { text, ...base };
}

// ---------- weekly report ----------

/** Monday (YYYY-MM-DD) of the week containing `ymd`. */
export function mondayOf(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDays(ymd, -((wd + 6) % 7));
}

/** Default: the last completed Monday-Sunday week in `tz`. */
export function resolveWeekStart(weekStart: string | undefined, tz: string, now = new Date()): string {
  if (weekStart !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart) || Number.isNaN(Date.parse(weekStart))) {
      throw new HttpError(400, "VALIDATION_ERROR", "weekStart must be YYYY-MM-DD");
    }
    return mondayOf(weekStart);
  }
  return addDays(mondayOf(localDateString(now, tz)), -7);
}

export function weeklyText(r: Omit<WeeklyReport, "text"> & { count: number }, currency: string, now: Date, tz: string): string {
  const money = (n: number) => formatMoney(n, currency);
  const lastWeek = r.weekStart === addDays(mondayOf(localDateString(now, tz)), -7);
  const span = lastWeek ? "Last week" : `From ${speakYmd(r.weekStart)} to ${speakYmd(r.weekEnd)}`;
  if (!r.count) {
    return `${span} you didn't log any spending.${r.previousTotal ? ` The week before you spent ${money(r.previousTotal)}.` : ""}`;
  }
  const parts = [`${span} you spent ${money(r.total)} across ${plural(r.count, "expense")}`];
  if (r.changePercent === null) parts[0] += ".";
  else if (Math.abs(r.changePercent) < 3) parts[0] += ", about the same as the week before.";
  else parts[0] += `, ${Math.abs(Math.round(r.changePercent))}% ${r.changePercent > 0 ? "more" : "less"} than the week before.`;
  const top = r.byCategory[0];
  if (top) parts.push(`Most of it went to ${top.category} at ${money(top.total)}.`);
  const m = r.topMerchants[0];
  if (m) parts.push(`Your top merchant was ${m.merchant}, ${money(m.total)} over ${plural(m.count, "payment")}.`);
  return parts.join(" ");
}

export async function buildWeeklyReport(
  userId: string,
  opts: { weekStart?: string; currency?: string },
  tz: string,
  now = new Date(),
): Promise<WeeklyReport> {
  const weekStart = resolveWeekStart(opts.weekStart, tz, now);
  const weekEnd = addDays(weekStart, 6);
  const start = startOfDay(weekStart, tz);
  const end = startOfDay(addDays(weekStart, 7), tz);
  const prevStart = startOfDay(addDays(weekStart, -7), tz);

  const [res] = await ExpenseModel.aggregate<{
    totals: { total: number; count: number }[];
    prev: { total: number }[];
    byCategory: { _id: string; total: number; count: number }[];
    merchants: { _id: string; total: number; count: number }[];
  }>([
    { $match: { userId: oid(userId), date: { $gte: prevStart, $lt: end } } },
    {
      $facet: {
        totals: [{ $match: { date: { $gte: start } } }, { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } }],
        prev: [{ $match: { date: { $lt: start } } }, { $group: { _id: null, total: { $sum: "$amount" } } }],
        byCategory: [
          { $match: { date: { $gte: start } } },
          { $group: { _id: "$category", total: { $sum: "$amount" }, count: { $sum: 1 } } },
          { $sort: { total: -1, _id: 1 } },
        ],
        merchants: [
          { $match: { date: { $gte: start }, merchant: { $nin: [null, ""] } } },
          // Group case-insensitively; $min picks the capitalised spelling ("Swiggy" < "swiggy").
          { $group: { _id: { $toLower: "$merchant" }, name: { $min: "$merchant" }, total: { $sum: "$amount" }, count: { $sum: 1 } } },
          { $sort: { total: -1, _id: 1 } },
          { $limit: 5 },
          { $project: { _id: "$name", total: 1, count: 1 } },
        ],
      },
    },
  ]);

  const total = round2(res?.totals[0]?.total ?? 0);
  const count = res?.totals[0]?.count ?? 0;
  const previousTotal = round2(res?.prev[0]?.total ?? 0);
  const report: Omit<WeeklyReport, "text"> = {
    weekStart,
    weekEnd,
    total,
    previousTotal,
    changePercent: previousTotal > 0 ? Math.round(((total - previousTotal) / previousTotal) * 1000) / 10 : null,
    byCategory: (res?.byCategory ?? [])
      .filter((c) => (CATEGORIES as readonly string[]).includes(c._id))
      .map((c) => ({ category: c._id as Category, total: round2(c.total), count: c.count })),
    topMerchants: (res?.merchants ?? []).map((m) => ({ merchant: m._id, total: round2(m.total), count: m.count })),
  };
  return { text: weeklyText({ ...report, count }, opts.currency || "INR", now, tz), ...report };
}
