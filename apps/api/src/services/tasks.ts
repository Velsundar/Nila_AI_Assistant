import { Types, isValidObjectId } from "mongoose";
import type { Task, TaskPriority } from "@nova/shared";
import { DEFAULT_TASK_LIST } from "@nova/shared";
import { TaskModel } from "../models/Task";
import { notFound } from "../errors";
import { addDays, localDateString, parseExpenseDate, startOfDay } from "./dates";
import { toTask } from "./serialize";

const oid = (id: string) => new Types.ObjectId(id);

/** "my shopping list" -> "Shopping", "to-do" -> "Inbox". */
export function normalizeListName(raw: string | undefined | null): string {
  let s = (raw ?? "").trim().replace(/\s+/g, " ");
  s = s.replace(/^(my|the|our)\s+/i, "").replace(/\s+list$/i, "").trim();
  if (!s || /^(to ?-?do'?s?|tasks?|inbox|default|general)$/i.test(s)) return DEFAULT_TASK_LIST;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const listKey = (name: string) => name.trim().toLowerCase();

/** Reuse the casing of an existing list ("shopping" -> the user's "Shopping"). */
async function resolveListName(userId: string, raw: string | undefined): Promise<string> {
  const name = normalizeListName(raw);
  const existing = await TaskModel.findOne({ userId: oid(userId), listKey: listKey(name) }).select("list").lean();
  return existing?.list ?? name;
}

/** Date-only due dates land at noon local time (like expenses) so they stay on the right calendar day. */
function parseDue(s: string, tz: string): Date {
  return parseExpenseDate(s, tz);
}

export type TaskFilter = { list?: string; done?: boolean; when?: "today" | "overdue" | "all" };

export async function createTask(
  userId: string,
  input: { title: string; list?: string; dueDate?: string; priority?: TaskPriority },
  tz: string,
): Promise<Task> {
  const list = await resolveListName(userId, input.list);
  const doc = await TaskModel.create({
    userId: oid(userId),
    title: input.title.trim(),
    list,
    listKey: listKey(list),
    ...(input.dueDate ? { dueDate: parseDue(input.dueDate, tz) } : {}),
    priority: input.priority ?? "normal",
  });
  return toTask(doc);
}

/** Open tasks first, then by due date (undated last), then oldest first. */
export async function listTasks(userId: string, f: TaskFilter, tz: string, now = new Date()): Promise<Task[]> {
  const filter: Record<string, unknown> = { userId: oid(userId) };
  if (f.list) filter.listKey = listKey(normalizeListName(f.list));
  if (f.done !== undefined) filter.done = f.done;
  if (f.when === "today" || f.when === "overdue") {
    const today = localDateString(now, tz);
    const bound = f.when === "today" ? startOfDay(addDays(today, 1), tz) : startOfDay(today, tz);
    filter.done = false;
    filter.dueDate = { $lt: bound };
  }
  const docs = await TaskModel.find(filter).limit(500).lean();
  const far = Number.MAX_SAFE_INTEGER;
  return docs
    .sort(
      (a, b) =>
        Number(!!a.done) - Number(!!b.done) ||
        (a.dueDate?.getTime() ?? far) - (b.dueDate?.getTime() ?? far) ||
        (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0),
    )
    .map(toTask);
}

export async function updateTask(
  userId: string,
  id: string,
  input: { title?: string; list?: string; dueDate?: string | null; priority?: TaskPriority; done?: boolean },
  tz: string,
): Promise<Task> {
  if (!isValidObjectId(id)) throw notFound("Task");
  const set: Record<string, unknown> = {};
  const unset: Record<string, 1> = {};
  if (input.title !== undefined) set.title = input.title.trim();
  if (input.list !== undefined) {
    const list = await resolveListName(userId, input.list);
    set.list = list;
    set.listKey = listKey(list);
  }
  if (input.dueDate === null) unset.dueDate = 1;
  else if (input.dueDate !== undefined) set.dueDate = parseDue(input.dueDate, tz);
  if (input.priority !== undefined) set.priority = input.priority;
  if (input.done !== undefined) {
    set.done = input.done;
    if (input.done) set.completedAt = new Date();
    else unset.completedAt = 1;
  }
  const doc = await TaskModel.findOneAndUpdate(
    { _id: id, userId: oid(userId) },
    { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) },
    { new: true },
  ).lean();
  if (!doc) throw notFound("Task");
  return toTask(doc);
}

export async function deleteTask(userId: string, id: string): Promise<Task> {
  if (!isValidObjectId(id)) throw notFound("Task");
  const doc = await TaskModel.findOneAndDelete({ _id: id, userId: oid(userId) }).lean();
  if (!doc) throw notFound("Task");
  return toTask(doc);
}

// ---------- fuzzy title matching (for voice: "mark milk as done") ----------

const FILLER = new Set(["the", "a", "an", "my", "to", "task", "item", "some", "of", "for"]);
const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !FILLER.has(w))
    .map((w) => (w.length > 3 ? w.replace(/(es|s)$/, "") : w));

/** 0..1 similarity between a spoken phrase and a task title. */
export function titleSimilarity(query: string, title: string): number {
  const q = words(query);
  const t = words(title);
  if (!q.length || !t.length) return 0;
  const qs = q.join(" ");
  const ts = t.join(" ");
  if (qs === ts) return 1;
  if (ts.includes(qs) || qs.includes(ts)) return 0.85;
  const hits = q.filter((w) => t.some((x) => x === w || (w.length > 3 && (x.startsWith(w) || w.startsWith(x))))).length;
  return hits / Math.max(q.length, t.length);
}

/** Best-matching task per query (each task is used at most once). */
export async function findTasksByTitle(
  userId: string,
  queries: string[],
  opts: { list?: string; includeDone?: boolean } = {},
): Promise<{ matches: Task[]; missing: string[] }> {
  const filter: Record<string, unknown> = { userId: oid(userId) };
  if (!opts.includeDone) filter.done = false;
  if (opts.list) filter.listKey = listKey(normalizeListName(opts.list));
  const pool = (await TaskModel.find(filter).sort({ createdAt: -1 }).limit(300).lean()).map(toTask);
  const used = new Set<string>();
  const matches: Task[] = [];
  const missing: string[] = [];
  for (const q of queries) {
    let best: { t: Task; score: number } | undefined;
    for (const t of pool) {
      if (used.has(t.id)) continue;
      const score = titleSimilarity(q, t.title);
      if (score >= 0.5 && (!best || score > best.score)) best = { t, score };
    }
    if (best) {
      used.add(best.t.id);
      matches.push(best.t);
    } else missing.push(q);
  }
  return { matches, missing };
}
