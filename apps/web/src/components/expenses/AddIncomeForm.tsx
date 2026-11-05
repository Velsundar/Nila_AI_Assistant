"use client";

import { INCOME_CATEGORIES, type Income, type IncomeCategory } from "@nova/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Notice, SelectField, TextField } from "@/components/ui";
import { api, errorMessage, fieldErrors } from "@/lib/api";
import { notifyDataChanged } from "@/lib/events";
import { dayKey } from "@/lib/format";

type FormState = { amount: string; category: IncomeCategory; payer: string; date: string; note: string };

/** Add-income form (money received). Same shape and validation as AddExpenseForm, minus receipt drafts. */
export function AddIncomeForm({ defaultDate, onSaved }: { defaultDate: string; onSaved?: (i: Income) => void }) {
  const empty: FormState = { amount: "", category: "Salary", payer: "", date: defaultDate, note: "" };
  const [form, setForm] = useState<FormState>(empty);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    setForm((f) => ({ ...f, date: defaultDate }));
  }, [defaultDate]);

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
      const { income } = await api.income.create({
        amount: Math.round(amount * 100) / 100,
        category: form.category,
        payer: form.payer.trim() || undefined,
        note: form.note.trim() || undefined,
        // Noon local time so the entry lands on the chosen day in any timezone.
        date: new Date(`${form.date}T12:00:00`).toISOString(),
        source: "manual",
      });
      setForm({ ...empty, category: form.category, date: form.date });
      setDone(true);
      notifyDataChanged(); // dashboard listens and refetches
      onSaved?.(income);
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
    <form onSubmit={submit} noValidate className="grid grid-cols-2 gap-3" aria-label="Add income">
      {formError && <Notice tone="danger" className="col-span-2">{formError}</Notice>}
      <TextField label="Amount (₹)" type="number" inputMode="decimal" min="0" step="0.01" placeholder="75000" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} error={errors.amount} />
      <SelectField label="Category" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as IncomeCategory })} error={errors.category}>
        {INCOME_CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </SelectField>
      <TextField label="From" placeholder="Acme Corp" maxLength={100} value={form.payer} onChange={(e) => setForm({ ...form, payer: e.target.value })} error={errors.payer} />
      <TextField label="Date" type="date" max={dayKey()} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} error={errors.date} />
      <TextField label="Note" placeholder="Optional" maxLength={500} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} error={errors.note} className="col-span-2" />
      <div className="col-span-2 flex items-center gap-3">
        <Button type="submit" variant="secondary" loading={busy} className="flex-1">
          Add income
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
