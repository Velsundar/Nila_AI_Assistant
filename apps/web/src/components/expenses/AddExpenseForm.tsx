"use client";

import { CATEGORIES, LEGACY_CATEGORIES, SUBCATEGORIES, type Category, type Expense, type ReceiptScanResult } from "@nova/shared";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button, Notice, SelectField, TextField } from "@/components/ui";
import { api, errorMessage, fieldErrors } from "@/lib/api";
import { notifyDataChanged } from "@/lib/events";
import { dayKey, localDayOf } from "@/lib/format";
import { ConfidenceBadge } from "./ReceiptScanner";

export type ExpenseDraft = ReceiptScanResult & { preview?: string };

type FormState = { amount: string; category: Category; subcategory: string; merchant: string; date: string; note: string };

/** A current category name, mapping pre-v5 names ("Transport") to their new ones. */
function toCategory(c: string | undefined): Category | undefined {
  if (!c) return undefined;
  if ((CATEGORIES as readonly string[]).includes(c)) return c as Category;
  return LEGACY_CATEGORIES[c];
}

function fromDraft(d: ExpenseDraft["draft"], fallbackDate: string, fallbackCategory: Category): FormState {
  const day = d.date ? localDayOf(d.date) || d.date.slice(0, 10) : "";
  return {
    amount: d.amount !== undefined ? String(d.amount) : "",
    category: toCategory(d.category) ?? fallbackCategory,
    subcategory: d.subcategory ?? "",
    merchant: d.merchant ?? "",
    // Receipts can't be in the future; keep a sane date if the scan misread it.
    date: day && day <= dayKey() ? day : fallbackDate,
    note: d.note ?? "",
  };
}

/**
 * Add-expense form. With `draft` (from a receipt scan) it's prefilled and shows the scan's confidence;
 * the user always confirms with the submit button. Nothing is saved automatically.
 */
export function AddExpenseForm({
  defaultDate,
  draft,
  onSaved,
  onCancelDraft,
  autoFocus,
}: {
  defaultDate: string;
  draft?: ExpenseDraft | null;
  onSaved?: (e: Expense) => void;
  onCancelDraft?: () => void;
  autoFocus?: boolean;
}) {
  const empty: FormState = { amount: "", category: "Food", subcategory: "", merchant: "", date: defaultDate, note: "" };
  const subListId = useId();
  const [form, setForm] = useState<FormState>(empty);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!draft) setForm((f) => ({ ...f, date: defaultDate }));
  }, [defaultDate, draft]);

  // A new scan replaces the form contents and moves focus to the first field to check.
  useEffect(() => {
    if (!draft) return;
    setForm((f) => fromDraft(draft.draft, defaultDate, f.category));
    setErrors({});
    setFormError(null);
    setDone(false);
    requestAnimationFrame(() => amountRef.current?.focus());
  }, [draft, defaultDate]);

  useEffect(() => {
    if (autoFocus) amountRef.current?.focus();
  }, [autoFocus]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (submitting.current) return; // ref, not state: blocks same-tick double submits
    setFormError(null);
    setDone(false);
    const amount = Number(form.amount);
    const errs: Record<string, string> = {};
    if (!form.amount || !Number.isFinite(amount) || amount <= 0) errs.amount = "Enter an amount greater than 0.";
    if (!form.date) errs.date = "Pick a date.";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    submitting.current = true;
    setBusy(true);
    try {
      const { expense } = await api.expenses.create({
        amount: Math.round(amount * 100) / 100,
        category: form.category,
        // Omitted → the server infers it from the merchant / note ("Swiggy" → Food / Swiggy).
        subcategory: form.subcategory.trim() || undefined,
        merchant: form.merchant.trim() || undefined,
        note: form.note.trim() || undefined,
        // Noon local time so the expense lands on the chosen day in any timezone.
        date: new Date(`${form.date}T12:00:00`).toISOString(),
        source: draft ? "receipt" : "manual",
      });
      setForm({ ...empty, category: form.category, date: draft ? defaultDate : form.date });
      setDone(true);
      notifyDataChanged(); // dashboard / today listen and refetch
      onSaved?.(expense);
    } catch (err) {
      const fe = fieldErrors(err);
      setErrors(fe);
      if (!Object.keys(fe).length) setFormError(errorMessage(err));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="grid grid-cols-2 gap-3" aria-label={draft ? "Confirm scanned expense" : "Add expense"}>
      {draft && (
        <div className="col-span-2 flex items-center gap-3 rounded-control border border-accent/30 bg-accent/5 p-2.5" role="status">
          {draft.preview && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={draft.preview} alt="Scanned receipt" className="size-12 shrink-0 rounded-md border border-line object-cover" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg">
              From receipt <ConfidenceBadge confidence={draft.confidence} />
            </div>
            <p className="text-xs text-muted">
              {draft.confidence === "low" ? "Some fields may be wrong. Check everything before saving." : "Check the details, then save."}
            </p>
          </div>
          {onCancelDraft && (
            <Button size="sm" variant="ghost" onClick={onCancelDraft} aria-label="Discard scanned receipt">
              Discard
            </Button>
          )}
        </div>
      )}
      {formError && <Notice tone="danger" className="col-span-2">{formError}</Notice>}
      <TextField ref={amountRef} label="Amount (₹)" type="number" inputMode="decimal" min="0" step="0.01" placeholder="250" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} error={errors.amount} />
      <SelectField
        label="Category"
        value={form.category}
        onChange={(e) => {
          const category = e.target.value as Category;
          // A suggestion from the old category doesn't belong to the new one; typed text stays.
          const keep = !SUBCATEGORIES[form.category].includes(form.subcategory);
          setForm({ ...form, category, subcategory: keep ? form.subcategory : "" });
        }}
        error={errors.category}
      >
        {CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </SelectField>
      <TextField
        label="Subcategory"
        list={subListId}
        placeholder={SUBCATEGORIES[form.category][0] ?? "Optional"}
        maxLength={40}
        autoComplete="off"
        value={form.subcategory}
        onChange={(e) => setForm({ ...form, subcategory: e.target.value })}
        error={errors.subcategory}
      />
      <datalist id={subListId}>
        {SUBCATEGORIES[form.category].map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      <TextField label="Merchant" placeholder="Swiggy" maxLength={100} value={form.merchant} onChange={(e) => setForm({ ...form, merchant: e.target.value })} error={errors.merchant} />
      <TextField label="Date" type="date" max={dayKey()} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} error={errors.date} />
      <TextField label="Note" placeholder="Optional" maxLength={500} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} error={errors.note} />
      <div className="col-span-2 flex items-center gap-3">
        <Button type="submit" loading={busy} className="flex-1">
          {draft ? "Save expense" : "Add expense"}
        </Button>
        {done && (
          <span role="status" className="text-sm text-ok">
            Added ✓
          </span>
        )}
      </div>
    </form>
  );
}
