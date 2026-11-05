"use client";

import { DEFAULT_TASK_LIST, type Task, type TaskPriority, type UpdateTaskInput } from "@nova/shared";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { Button, Card, Spinner } from "@/components/ui";
import { api, errorMessage, fieldErrors } from "@/lib/api";
import { cn } from "@/lib/cn";
import { DATA_CHANGED_EVENT, DATA_VERSION_KEY, notifyDataChanged } from "@/lib/events";
import { dueLabel, localDayOf, shortDate, timeOf } from "@/lib/format";

type Filter = "open" | "done" | "all";
const PRIORITY_RANK: Record<TaskPriority, number> = { high: 0, normal: 1, low: 2 };

const inputCls =
  "h-10 w-full min-w-0 rounded-control border border-line bg-surface-2 px-3 text-sm text-fg placeholder:text-faint transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 focus-visible:outline-none";

function sortTasks(a: Task, b: Task) {
  if (a.done !== b.done) return a.done ? 1 : -1;
  if (a.done && b.done) return (b.completedAt ?? "").localeCompare(a.completedAt ?? "");
  const ad = a.dueDate ?? "9999";
  const bd = b.dueDate ?? "9999";
  if (ad !== bd) return ad.localeCompare(bd);
  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.createdAt.localeCompare(a.createdAt);
}

/** Tasks grouped by list, with add / check off / delete and an open/done filter. */
export function TasksCard({ className }: { className?: string }) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("open");
  const [listFilter, setListFilter] = useState<string | null>(null);
  /** The task whose details panel is open (one at a time). */
  const [openId, setOpenId] = useState<string | null>(null);
  const reqId = useRef(0);

  const load = useCallback(async () => {
    const id = ++reqId.current;
    try {
      const { tasks } = await api.tasks.list();
      if (id === reqId.current) {
        setTasks(tasks);
        setError(null);
      }
    } catch (err) {
      if (id === reqId.current) setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
    const on = () => void load();
    const onStorage = (e: StorageEvent) => e.key === DATA_VERSION_KEY && on();
    window.addEventListener(DATA_CHANGED_EVENT, on);
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", on);
    return () => {
      window.removeEventListener(DATA_CHANGED_EVENT, on);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", on);
    };
  }, [load]);

  const lists = useMemo(() => {
    const names = new Map<string, string>(); // lowercase → display
    names.set(DEFAULT_TASK_LIST.toLowerCase(), DEFAULT_TASK_LIST);
    for (const t of tasks ?? []) if (!names.has(t.list.toLowerCase())) names.set(t.list.toLowerCase(), t.list);
    const all = [...names.values()];
    return [DEFAULT_TASK_LIST, ...all.filter((n) => n !== DEFAULT_TASK_LIST).sort((a, b) => a.localeCompare(b))];
  }, [tasks]);

  const groups = useMemo(() => {
    const visible = (tasks ?? []).filter(
      (t) => (filter === "all" || (filter === "done" ? t.done : !t.done)) && (!listFilter || t.list.toLowerCase() === listFilter.toLowerCase()),
    );
    return lists
      .map((name) => ({ name, items: visible.filter((t) => t.list.toLowerCase() === name.toLowerCase()).sort(sortTasks) }))
      .filter((g) => g.items.length > 0);
  }, [tasks, filter, listFilter, lists]);

  const openCount = (tasks ?? []).filter((t) => !t.done).length;
  const doneCount = (tasks ?? []).length - openCount;

  async function toggle(t: Task) {
    const next = !t.done;
    setTasks((ts) => ts?.map((x) => (x.id === t.id ? { ...x, done: next, completedAt: next ? new Date().toISOString() : undefined } : x)) ?? ts);
    try {
      const { task } = await api.tasks.update(t.id, { done: next });
      setTasks((ts) => ts?.map((x) => (x.id === t.id ? task : x)) ?? ts);
      notifyDataChanged();
    } catch (err) {
      setTasks((ts) => ts?.map((x) => (x.id === t.id ? t : x)) ?? ts);
      setError(errorMessage(err));
    }
  }

  /** Throws on failure so the details form can show the error next to the fields. */
  async function save(t: Task, input: UpdateTaskInput) {
    const { task } = await api.tasks.update(t.id, input);
    setTasks((ts) => ts?.map((x) => (x.id === t.id ? task : x)) ?? ts);
    notifyDataChanged();
  }

  async function remove(t: Task) {
    if (openId === t.id) setOpenId(null);
    setTasks((ts) => ts?.filter((x) => x.id !== t.id) ?? ts);
    try {
      await api.tasks.remove(t.id);
      notifyDataChanged();
    } catch (err) {
      setTasks((ts) => (ts ? [...ts, t] : ts));
      setError(errorMessage(err));
    }
  }

  return (
    <Card
      title="Tasks"
      className={className}
      action={
        <div role="group" aria-label="Show tasks" className="flex rounded-control border border-line bg-surface-2/60 p-0.5 text-xs">
          {(
            [
              ["open", `Open${tasks ? ` ${openCount}` : ""}`],
              ["done", `Done${tasks ? ` ${doneCount}` : ""}`],
              ["all", "All"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              aria-pressed={filter === k}
              onClick={() => setFilter(k)}
              className={cn(
                "h-7 rounded-[0.5rem] px-2.5 font-medium tabular-nums transition-colors",
                filter === k ? "bg-surface-3 text-fg" : "text-muted hover:text-fg",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      }
    >
      <AddTaskForm lists={lists} defaultList={listFilter ?? DEFAULT_TASK_LIST} onAdded={(t) => setTasks((ts) => (ts ? [t, ...ts] : [t]))} />

      {lists.length > 1 && (
        <div role="group" aria-label="Filter by list" className="mt-4 flex gap-1.5 overflow-x-auto pb-1">
          {[null, ...lists].map((l) => (
            <button
              key={l ?? "__all"}
              type="button"
              aria-pressed={listFilter === l}
              onClick={() => setListFilter(l)}
              className={cn(
                "shrink-0 rounded-full border px-3 py-1 text-xs transition-colors",
                listFilter === l ? "border-accent/60 bg-accent/10 text-accent" : "border-line text-muted hover:border-line-strong hover:text-fg",
              )}
            >
              {l ?? "All lists"}
            </button>
          ))}
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}

      {!tasks ? (
        <div className="grid h-32 place-items-center text-muted" role="status" aria-label="Loading tasks">
          <Spinner className="size-5" />
        </div>
      ) : groups.length === 0 ? (
        <p className="py-8 text-center text-sm text-faint">
          {filter === "done" ? "Nothing checked off yet." : filter === "open" ? "All clear. Add a task, or say “add milk to my shopping list”." : "No tasks yet."}
        </p>
      ) : (
        <div className="mt-4 grid gap-5 md:grid-cols-2">
          {groups.map((g) => (
            <section key={g.name} aria-labelledby={`list-${g.name}`} className="min-w-0">
              <h3 id={`list-${g.name}`} className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted">
                <ListIcon name={g.name} />
                {g.name}
                <span className="font-normal tabular-nums text-faint">{g.items.length}</span>
              </h3>
              <ul className="divide-y divide-line/50 rounded-control border border-line/70 bg-surface-2/30">
                {g.items.map((t) => (
                  <TaskRow
                    key={t.id}
                    task={t}
                    lists={lists}
                    open={openId === t.id}
                    onOpenChange={(o) => setOpenId(o ? t.id : null)}
                    onToggle={() => void toggle(t)}
                    onSave={(input) => save(t, input)}
                    onDelete={() => void remove(t)}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Card>
  );
}

function ListIcon({ name }: { name: string }) {
  const n = name.toLowerCase();
  const glyph = /shop|grocer/.test(n) ? "🛒" : /work|office/.test(n) ? "💼" : /home|house/.test(n) ? "🏠" : n === "inbox" ? "📥" : "📋";
  return <span aria-hidden="true">{glyph}</span>;
}

const PRIORITY_LABEL: Record<TaskPriority, string> = { low: "Low", normal: "Normal", high: "High" };

function fullDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" })}, ${timeOf(iso)}`;
}

/**
 * Only the checkbox toggles done. Clicking the row (or Enter on the title button) opens the details
 * panel below it; Escape closes it and returns focus to the title.
 */
function TaskRow({
  task: t,
  lists,
  open,
  onOpenChange,
  onToggle,
  onSave,
  onDelete,
}: {
  task: Task;
  lists: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onToggle: () => void;
  onSave: (input: UpdateTaskInput) => Promise<void>;
  onDelete: () => void;
}) {
  const id = useId();
  const titleBtn = useRef<HTMLButtonElement>(null);
  const due = t.dueDate ? dueLabel(t.dueDate) : null;
  const close = () => {
    onOpenChange(false);
    titleBtn.current?.focus();
  };
  return (
    <li
      className={cn("group", open && "bg-surface-2/60")}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          close();
        }
      }}
    >
      {/* The row's empty space opens details too; the checkbox and buttons handle their own clicks. */}
      <div
        className="flex cursor-pointer items-center gap-3 px-3 py-2.5"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("input,button")) return;
          onOpenChange(!open);
        }}
      >
        <input
          id={id}
          type="checkbox"
          checked={t.done}
          onChange={onToggle}
          aria-label={`${t.done ? "Mark not done" : "Mark done"}: ${t.title}`}
          className="size-4.5 shrink-0 cursor-pointer accent-[var(--color-accent)]"
        />
        <button
          ref={titleBtn}
          type="button"
          onClick={() => onOpenChange(!open)}
          aria-expanded={open}
          aria-controls={`${id}-details`}
          className="min-w-0 flex-1 rounded-[0.4rem] text-left"
        >
          <span className={cn("block truncate text-sm", t.done ? "text-faint line-through" : "text-fg")}>{t.title}</span>
          {(due || t.priority !== "normal") && (
            <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px]">
              {due && !t.done && (
                <span
                  className={cn(
                    "rounded-full px-1.5 py-px",
                    due.tone === "overdue" ? "bg-danger/15 text-danger" : due.tone === "today" ? "bg-warn/15 text-warn" : "bg-surface-3 text-muted",
                  )}
                >
                  <span className="sr-only">Due </span>
                  {due.label}
                </span>
              )}
              {due && t.done && <span className="text-faint">Was due {due.label.replace("Overdue · ", "")}</span>}
              {t.priority === "high" && <span className="rounded-full bg-danger/10 px-1.5 py-px text-danger">High priority</span>}
              {t.priority === "low" && <span className="rounded-full bg-surface-3 px-1.5 py-px text-faint">Low priority</span>}
            </span>
          )}
          <span className="sr-only">. Show details</span>
        </button>
        <svg aria-hidden="true" viewBox="0 0 20 20" className={cn("size-4 shrink-0 text-faint transition-transform", open && "rotate-180")} fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M5.5 7.5 10 12l4.5-4.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      {open && <TaskDetails id={`${id}-details`} task={t} lists={lists} onSave={onSave} onDelete={onDelete} onClose={close} />}
    </li>
  );
}

function TaskDetails({
  id,
  task: t,
  lists,
  onSave,
  onDelete,
  onClose,
}: {
  id: string;
  task: Task;
  lists: string[];
  onSave: (input: UpdateTaskInput) => Promise<void>;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [title, setTitle] = useState(t.title);
  const [list, setList] = useState(t.list);
  const [due, setDue] = useState(t.dueDate ? localDayOf(t.dueDate) : "");
  const [priority, setPriority] = useState<TaskPriority>(t.priority);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const base = useId();

  function startEdit() {
    setTitle(t.title);
    setList(t.list);
    setDue(t.dueDate ? localDayOf(t.dueDate) : "");
    setPriority(t.priority);
    setError(null);
    setEditing(true);
    requestAnimationFrame(() => titleRef.current?.focus());
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (submitting.current) return;
    const nextTitle = title.trim();
    if (!nextTitle) {
      setError("Give the task a title.");
      titleRef.current?.focus();
      return;
    }
    const input: UpdateTaskInput = {};
    if (nextTitle !== t.title) input.title = nextTitle;
    const nextList = list.trim() || DEFAULT_TASK_LIST;
    if (nextList !== t.list) input.list = nextList;
    const oldDue = t.dueDate ? localDayOf(t.dueDate) : "";
    if (due !== oldDue) input.dueDate = due ? new Date(`${due}T23:59:00`).toISOString() : null;
    if (priority !== t.priority) input.priority = priority;
    if (!Object.keys(input).length) return setEditing(false);
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      await onSave(input);
      setEditing(false);
    } catch (err) {
      const fe = fieldErrors(err);
      setError(fe.title ?? fe.list ?? fe.dueDate ?? fe.priority ?? errorMessage(err));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <div id={id} role="region" aria-label={`Details: ${t.title}`} className="border-t border-line/50 px-3 pb-3 pt-2.5">
      {editing ? (
        <form onSubmit={submit} noValidate className="grid gap-2" aria-label={`Edit task ${t.title}`}>
          <div>
            <label htmlFor={`${base}-t`} className="mb-1 block text-[11px] font-medium text-muted">
              Title
            </label>
            <input ref={titleRef} id={`${base}-t`} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} className={cn(inputCls, error && !title.trim() && "border-danger")} />
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <div className="col-span-2 min-w-0 sm:col-span-1">
              <label htmlFor={`${base}-l`} className="mb-1 block text-[11px] font-medium text-muted">
                List
              </label>
              <input id={`${base}-l`} list={`${base}-ls`} value={list} onChange={(e) => setList(e.target.value)} maxLength={40} className={inputCls} />
              <datalist id={`${base}-ls`}>
                {lists.map((l) => (
                  <option key={l} value={l} />
                ))}
              </datalist>
            </div>
            <div className="min-w-0">
              <label htmlFor={`${base}-d`} className="mb-1 block text-[11px] font-medium text-muted">
                Due
              </label>
              <input id={`${base}-d`} type="date" value={due} onChange={(e) => setDue(e.target.value)} className={cn(inputCls, "px-2")} />
            </div>
            <div className="min-w-0">
              <label htmlFor={`${base}-p`} className="mb-1 block text-[11px] font-medium text-muted">
                Priority
              </label>
              <select id={`${base}-p`} value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)} className={cn(inputCls, "appearance-none px-2")}>
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
              </select>
            </div>
          </div>
          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" loading={busy}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
            <dt className="text-faint">List</dt>
            <dd className="truncate text-fg">{t.list}</dd>
            <dt className="text-faint">Due</dt>
            <dd className="text-fg">{t.dueDate ? shortDate(t.dueDate) : "No due date"}</dd>
            <dt className="text-faint">Priority</dt>
            <dd className="text-fg">{PRIORITY_LABEL[t.priority]}</dd>
            <dt className="text-faint">Created</dt>
            <dd className="text-muted">{fullDate(t.createdAt)}</dd>
            <dt className="text-faint">Completed</dt>
            <dd className="text-muted">{t.done && t.completedAt ? fullDate(t.completedAt) : "Not yet"}</dd>
          </dl>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" onClick={startEdit}>
              Edit
            </Button>
            {confirming ? (
              <>
                <Button size="sm" variant="danger" onClick={onDelete} autoFocus aria-label={`Confirm delete task ${t.title}`}>
                  Delete
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                  Keep
                </Button>
              </>
            ) : (
              <Button size="sm" variant="ghost" className="text-danger hover:bg-danger/10 hover:text-danger" onClick={() => setConfirming(true)} aria-label={`Delete task ${t.title}`}>
                Delete
              </Button>
            )}
            <Button size="sm" variant="ghost" className="ml-auto" onClick={onClose}>
              Close
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function AddTaskForm({ lists, defaultList, onAdded }: { lists: string[]; defaultList: string; onAdded: (t: Task) => void }) {
  const [title, setTitle] = useState("");
  const [list, setList] = useState(defaultList);
  const [due, setDue] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const base = useId();

  useEffect(() => setList(defaultList), [defaultList]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (submitting.current) return; // ref, not state: blocks same-tick double submits
    setAdded(null);
    const t = title.trim();
    if (!t) {
      setError("Give the task a title.");
      titleRef.current?.focus();
      return;
    }
    setError(null);
    submitting.current = true;
    setBusy(true);
    try {
      const { task } = await api.tasks.create({
        title: t,
        list: list.trim() || DEFAULT_TASK_LIST,
        priority,
        // End of the chosen local day, so "due today" stays today in every timezone.
        dueDate: due ? new Date(`${due}T23:59:00`).toISOString() : undefined,
      });
      onAdded(task);
      setTitle("");
      setDue("");
      setPriority("normal");
      setAdded(task.title);
      notifyDataChanged();
      titleRef.current?.focus();
    } catch (err) {
      const fe = fieldErrors(err);
      setError(fe.title ?? fe.list ?? fe.dueDate ?? errorMessage(err));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-2" aria-label="Add a task">
      <div className="flex gap-2">
        <label htmlFor={`${base}-title`} className="sr-only">
          New task
        </label>
        <input
          ref={titleRef}
          id={`${base}-title`}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Add a task…"
          maxLength={200}
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${base}-err` : undefined}
          className={cn(inputCls, error && "border-danger")}
        />
        <Button type="submit" loading={busy} className="h-10 shrink-0">
          Add
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <div className="col-span-2 min-w-0 sm:col-span-1">
          <label htmlFor={`${base}-list`} className="mb-1 block text-[11px] font-medium text-muted">
            List
          </label>
          <input id={`${base}-list`} list={`${base}-lists`} value={list} onChange={(e) => setList(e.target.value)} maxLength={40} className={inputCls} />
          <datalist id={`${base}-lists`}>
            {lists.map((l) => (
              <option key={l} value={l} />
            ))}
          </datalist>
        </div>
        <div className="min-w-0">
          <label htmlFor={`${base}-due`} className="mb-1 block text-[11px] font-medium text-muted">
            Due
          </label>
          <input id={`${base}-due`} type="date" value={due} min={localDayOf(new Date().toISOString())} onChange={(e) => setDue(e.target.value)} className={cn(inputCls, "px-2")} />
        </div>
        <div className="min-w-0">
          <label htmlFor={`${base}-prio`} className="mb-1 block text-[11px] font-medium text-muted">
            Priority
          </label>
          <select id={`${base}-prio`} value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)} className={cn(inputCls, "appearance-none px-2")}>
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
          </select>
        </div>
      </div>
      {error ? (
        <p id={`${base}-err`} role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : (
        <p role="status" className="min-h-0 text-xs text-ok">
          {added ? `Added “${added}”` : ""}
        </p>
      )}
    </form>
  );
}
