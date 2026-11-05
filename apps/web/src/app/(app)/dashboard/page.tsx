"use client";

import { CATEGORIES, type BudgetStatus, type Category, type Expense, type Income, type IncomeSummary, type SpendingSummary } from "@nova/shared";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { WeeklyReportCard } from "@/components/dashboard/WeeklyReportCard";
import { AddExpenseForm, type ExpenseDraft } from "@/components/expenses/AddExpenseForm";
import { AddIncomeForm } from "@/components/expenses/AddIncomeForm";
import { ReceiptDropzone } from "@/components/expenses/ReceiptScanner";
import { useAuth } from "@/components/AuthProvider";
import { CategoryDonut, DailyBars } from "@/components/dashboard/Charts";
import { Button, Card, Notice, SelectField, Spinner, TextField } from "@/components/ui";
import { api, errorMessage, fieldErrors } from "@/lib/api";
import { cn } from "@/lib/cn";
import { DATA_CHANGED_EVENT, DATA_VERSION_KEY, notifyDataChanged } from "@/lib/events";
import { dayKey, formatMoney, monthKey, monthLabel, monthRange, shiftMonth, shortDate } from "@/lib/format";

type Data = { summary: SpendingSummary; expenses: Expense[]; budgets: BudgetStatus[]; incomeSummary: IncomeSummary | null; income: Income[] };

export default function DashboardPage() {
  const { user } = useAuth();
  const currency = user?.currency || "INR";
  const [month, setMonth] = useState(() => monthKey());
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<ExpenseDraft | null>(null);
  const reqId = useRef(0);
  const isCurrentMonth = month === monthKey();

  const load = useCallback(async () => {
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    const { from, to } = monthRange(month);
    try {
      const [summary, list, budgets, incomeSummary, incomeList] = await Promise.all([
        api.expenses.summary({ from, to }),
        api.expenses.list({ from, to, limit: 100 }),
        api.budgets.list(),
        // Income is optional: an API from before income existed shouldn't take the dashboard down.
        api.income.summary({ from, to }).catch(() => null),
        api.income.list({ from, to, limit: 50 }).catch(() => ({ income: [] as Income[] })),
      ]);
      if (id !== reqId.current) return;
      setData({ summary, expenses: list.expenses, budgets: budgets.budgets, incomeSummary, income: incomeList.income });
    } catch (err) {
      if (id === reqId.current) setError(errorMessage(err));
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [month]);

  // Always refetch on mount / month change, and whenever another screen (the assistant) changes data.
  useEffect(() => {
    void load();
    const onChange = () => void load();
    window.addEventListener(DATA_CHANGED_EVENT, onChange);
    window.addEventListener("focus", onChange);
    const onStorage = (e: StorageEvent) => e.key === DATA_VERSION_KEY && onChange();
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(DATA_CHANGED_EVENT, onChange);
      window.removeEventListener("focus", onChange);
    };
  }, [load]);

  async function removeExpense(id: string) {
    const prev = data;
    setData((d) => (d ? { ...d, expenses: d.expenses.filter((e) => e.id !== id) } : d));
    try {
      await api.expenses.remove(id);
      notifyDataChanged();
    } catch (err) {
      setData(prev);
      setError(errorMessage(err));
    }
  }

  async function removeIncome(id: string) {
    const prev = data;
    setData((d) => (d ? { ...d, income: d.income.filter((i) => i.id !== id) } : d));
    try {
      await api.income.remove(id);
      notifyDataChanged();
    } catch (err) {
      setData(prev);
      setError(errorMessage(err));
    }
  }

  const days = monthRange(month).days;

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-16 pt-6 sm:px-6">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-accent/80">Dashboard</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{monthLabel(month)}</h1>
        </div>
        <div className="flex items-center gap-1.5" role="group" aria-label="Choose month">
          <Button variant="secondary" size="sm" aria-label="Previous month" onClick={() => setMonth((m) => shiftMonth(m, -1))}>
            <Chevron dir="left" />
          </Button>
          <label className="sr-only" htmlFor="month-picker">
            Month
          </label>
          <input
            id="month-picker"
            type="month"
            value={month}
            max={monthKey()}
            onChange={(e) => e.target.value && setMonth(e.target.value)}
            className="h-8 rounded-control border border-line bg-surface-2 px-2 text-sm text-fg focus:border-accent focus:outline-none"
          />
          <Button variant="secondary" size="sm" aria-label="Next month" disabled={isCurrentMonth} onClick={() => setMonth((m) => shiftMonth(m, 1))}>
            <Chevron dir="right" />
          </Button>
        </div>
      </div>

      {error && (
        <Notice tone="danger" className="mb-4 flex items-center justify-between gap-3">
          <span>{error}</span>
          <Button size="sm" variant="secondary" onClick={() => void load()}>
            Retry
          </Button>
        </Notice>
      )}

      {!data && loading ? (
        <div className="grid h-64 place-items-center text-muted" role="status" aria-label="Loading dashboard">
          <Spinner className="size-6" />
        </div>
      ) : data ? (
        <div className={cn("grid grid-cols-1 gap-4 transition-opacity lg:grid-cols-3", loading && "opacity-70")} aria-busy={loading}>
          <div className="grid grid-cols-2 gap-4 lg:col-span-3 lg:grid-cols-3">
            <Stat label="Spent this month" value={formatMoney(data.summary.total, currency)} accent />
            {data.incomeSummary && (
              <>
                <Stat label="Received this month" value={formatMoney(data.incomeSummary.total, currency)} tone="ok" />
                <Net received={data.incomeSummary.total} spent={data.summary.total} currency={currency} />
              </>
            )}
            <Stat label="Expenses" value={String(data.summary.count)} />
            <Stat label="Daily average" value={formatMoney(data.summary.total / (isCurrentMonth ? new Date().getDate() : days), currency)} className="max-lg:hidden" />
            <Stat label="Top category" value={topCategory(data.summary) ?? "—"} className="max-lg:hidden" />
          </div>

          <WeeklyReportCard currency={currency} className="lg:col-span-3" />

          <Card title="Spend by category" className="lg:col-span-1">
            <CategoryDonut summary={data.summary} currency={currency} />
          </Card>
          <Card title="Spend by day" className="lg:col-span-2">
            <DailyBars summary={data.summary} currency={currency} days={days} monthKey={month} />
          </Card>

          <Card title="Add expense" className="lg:col-span-1">
            <ReceiptDropzone onResult={setDraft} className="mb-4" />
            <AddExpenseForm
              defaultDate={isCurrentMonth ? dayKey() : `${month}-01`}
              draft={draft}
              onSaved={() => setDraft(null)}
              onCancelDraft={() => setDraft(null)}
            />
          </Card>

          <Card
            title="Recent expenses"
            className="lg:col-span-2"
            action={<span className="text-xs text-faint">{data.expenses.length} shown</span>}
          >
            <ExpenseList expenses={data.expenses} currency={currency} onDelete={removeExpense} />
          </Card>

          <Card title="Add income" className="lg:col-span-1">
            <AddIncomeForm defaultDate={isCurrentMonth ? dayKey() : `${month}-01`} />
          </Card>

          <Card
            title="Money in"
            className="lg:col-span-2"
            action={<span className="text-xs text-faint">{data.income.length} shown</span>}
          >
            <IncomeList income={data.income} currency={currency} onDelete={removeIncome} />
          </Card>

          <Card title="Budgets" className="lg:col-span-3" action={!isCurrentMonth ? <span className="text-xs text-faint">Showing the current month</span> : undefined}>
            <Budgets budgets={data.budgets} currency={currency} onChanged={() => void load()} />
          </Card>
        </div>
      ) : null}
    </main>
  );
}

function topCategory(s: SpendingSummary) {
  const top = [...s.byCategory].sort((a, b) => b.total - a.total)[0];
  return top && top.total > 0 ? top.category : null;
}

function Stat({ label, value, accent, tone, className }: { label: string; value: string; accent?: boolean; tone?: "ok" | "danger"; className?: string }) {
  return (
    <div className={cn("rounded-card border border-line bg-surface/80 p-4", accent && "border-accent/30 bg-gradient-to-br from-accent/10 to-glow/5", className)}>
      <div className="text-xs text-muted">{label}</div>
      <div className={cn("mt-1.5 truncate text-xl font-semibold tabular-nums sm:text-2xl", accent && "text-accent", tone === "ok" && "text-ok", tone === "danger" && "text-danger")}>
        {value}
      </div>
    </div>
  );
}

/** Received − spent for the month: green with a "+" when you came out ahead, red when you spent more. */
function Net({ received, spent, currency }: { received: number; spent: number; currency: string }) {
  const net = Math.round((received - spent) * 100) / 100;
  const value = net > 0 ? `+${formatMoney(net, currency)}` : formatMoney(net, currency);
  return <Stat label="Net" value={value} tone={net > 0 ? "ok" : net < 0 ? "danger" : undefined} />;
}

function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={dir === "left" ? "M12.5 15 7.5 10l5-5" : "M7.5 5l5 5-5 5"} />
    </svg>
  );
}

function ExpenseList({ expenses, currency, onDelete }: { expenses: Expense[]; currency: string; onDelete: (id: string) => void }) {
  const [confirming, setConfirming] = useState<string | null>(null);
  if (!expenses.length) return <p className="py-8 text-center text-sm text-faint">No expenses this month. Add one, or just tell your assistant.</p>;
  return (
    <ul className="-mx-2 max-h-[26rem] divide-y divide-line/60 overflow-y-auto">
      {expenses.map((e) => (
        <li key={e.id} className="flex items-center gap-3 px-2 py-2.5">
          <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full bg-surface-2 text-xs font-semibold text-muted">
            {e.category.slice(0, 2)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm text-fg">{e.merchant || e.category}</div>
            <div className="truncate text-xs text-faint">
              {shortDate(e.date)} · {e.category}
              {e.source === "voice" && " · 🎙 voice"}
              {e.source === "receipt" && " · 🧾 receipt"}
              {e.note && ` · ${e.note}`}
            </div>
          </div>
          <span className="shrink-0 text-sm font-medium tabular-nums">{formatMoney(e.amount, currency)}</span>
          {confirming === e.id ? (
            <span className="flex shrink-0 gap-1">
              <Button size="sm" variant="danger" onClick={() => onDelete(e.id)} aria-label={`Confirm delete ${formatMoney(e.amount, currency)} ${e.merchant || e.category}`}>
                Delete
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                Keep
              </Button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(e.id)}
              aria-label={`Delete ${formatMoney(e.amount, currency)} ${e.merchant || e.category} on ${shortDate(e.date)}`}
              className="grid size-8 shrink-0 place-items-center rounded-control text-faint transition-colors hover:bg-danger/10 hover:text-danger"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
              </svg>
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function IncomeList({ income, currency, onDelete }: { income: Income[]; currency: string; onDelete: (id: string) => void }) {
  const [confirming, setConfirming] = useState<string | null>(null);
  if (!income.length) return <p className="py-8 text-center text-sm text-faint">No income this month. Add it here, or say “75k salary credited”.</p>;
  return (
    <ul className="-mx-2 max-h-[20rem] divide-y divide-line/60 overflow-y-auto">
      {income.map((i) => {
        const label = i.payer || i.note || i.category;
        return (
          <li key={i.id} className="flex items-center gap-3 px-2 py-2.5">
            <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full bg-ok/10 text-xs font-semibold text-ok">
              {i.category.slice(0, 2)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-fg">{label}</div>
              <div className="truncate text-xs text-faint">
                {shortDate(i.date)} · {i.category}
                {i.source === "voice" && " · 🎙 voice"}
                {i.payer && i.note && ` · ${i.note}`}
              </div>
            </div>
            <span className="shrink-0 text-sm font-medium tabular-nums text-ok">+{formatMoney(i.amount, currency)}</span>
            {confirming === i.id ? (
              <span className="flex shrink-0 gap-1">
                <Button size="sm" variant="danger" onClick={() => onDelete(i.id)} aria-label={`Confirm delete ${formatMoney(i.amount, currency)} ${label}`}>
                  Delete
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                  Keep
                </Button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirming(i.id)}
                aria-label={`Delete income ${formatMoney(i.amount, currency)} ${label} on ${shortDate(i.date)}`}
                className="grid size-8 shrink-0 place-items-center rounded-control text-faint transition-colors hover:bg-danger/10 hover:text-danger"
              >
                <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
                </svg>
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Budgets({ budgets, currency, onChanged }: { budgets: BudgetStatus[]; currency: string; onChanged: () => void }) {
  const [category, setCategory] = useState<Category>("Food");
  const [limit, setLimit] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    const n = Number(limit);
    if (!limit || !Number.isFinite(n) || n <= 0) return setError("Enter a monthly limit greater than 0.");
    setError(undefined);
    setBusy(true);
    try {
      await api.budgets.upsert({ category, monthlyLimit: n });
      setLimit("");
      onChanged();
    } catch (err) {
      setError(fieldErrors(err).monthlyLimit ?? errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_18rem]">
      {budgets.length ? (
        <ul className="grid gap-4 sm:grid-cols-2">
          {budgets.map((b) => {
            const pct = b.percentUsed;
            const tone = pct > 90 ? "danger" : pct > 70 ? "warn" : "ok";
            return (
              <li key={b.category}>
                <div className="mb-1.5 flex items-baseline justify-between gap-2 text-sm">
                  <span className="font-medium">{b.category}</span>
                  <span className="tabular-nums text-muted">
                    <span className={cn(tone === "danger" ? "text-danger" : "text-fg")}>{formatMoney(b.spent, currency)}</span> / {formatMoney(b.monthlyLimit, currency)}
                  </span>
                </div>
                <div
                  className="h-2 overflow-hidden rounded-full bg-surface-3"
                  role="progressbar"
                  aria-label={`${b.category} budget used`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.min(100, Math.round(pct))}
                  aria-valuetext={`${Math.round(pct)}% used`}
                >
                  <div
                    className={cn("h-full rounded-full transition-[width] duration-500", tone === "danger" ? "bg-danger shadow-[0_0_12px_var(--color-danger)]" : tone === "warn" ? "bg-warn" : "bg-ok")}
                    style={{ width: `${Math.min(100, Math.max(2, pct))}%` }}
                  />
                </div>
                <div className={cn("mt-1 text-xs tabular-nums", tone === "danger" ? "text-danger" : "text-faint")}>
                  {Math.round(pct)}% used{pct > 100 && ` · over by ${formatMoney(b.spent - b.monthlyLimit, currency)}`}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-faint">No budgets yet. Set one here, or say “set a food budget of 5000”.</p>
      )}
      <form onSubmit={save} noValidate className="grid grid-cols-2 gap-3 self-start rounded-control border border-line/70 bg-surface-2/40 p-3">
        <SelectField label="Category" value={category} onChange={(e) => setCategory(e.target.value as Category)}>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </SelectField>
        <TextField label="Monthly limit" type="number" inputMode="decimal" min="0" placeholder="5000" value={limit} onChange={(e) => setLimit(e.target.value)} error={error} />
        <Button type="submit" variant="secondary" loading={busy} className="col-span-2">
          Set budget
        </Button>
      </form>
    </div>
  );
}
