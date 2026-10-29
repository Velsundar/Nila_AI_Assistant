"use client";

import { RegisterSchema } from "@nova/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { AuthLayout } from "@/components/AuthLayout";
import { useAuth } from "@/components/AuthProvider";
import { Button, Notice, TextField } from "@/components/ui";
import { errorMessage, fieldErrors, zodFieldErrors } from "@/lib/api";

export default function RegisterPage() {
  const { register } = useAuth();
  const router = useRouter();
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = RegisterSchema.safeParse({ ...form, name: form.name.trim(), email: form.email.trim() });
    if (!parsed.success) {
      const fe = zodFieldErrors(parsed.error);
      if (fe.password && form.password.length < 8) fe.password = "Use at least 8 characters.";
      setErrors(fe);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await register(parsed.data);
      router.replace("/today");
    } catch (err) {
      const fe = fieldErrors(err);
      setErrors(fe);
      if (!Object.keys(fe).length) setFormError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title="Create your account"
      subtitle="Track spending just by talking."
      footer={
        <>
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-accent hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        {formError && <Notice tone="danger">{formError}</Notice>}
        <TextField label="Name" autoComplete="name" value={form.name} onChange={set("name")} error={errors.name} required />
        <TextField label="Email" type="email" autoComplete="email" inputMode="email" value={form.email} onChange={set("email")} error={errors.email} required />
        <TextField label="Password" type="password" autoComplete="new-password" value={form.password} onChange={set("password")} error={errors.password} hint="At least 8 characters." required />
        <Button type="submit" loading={busy} className="mt-2 w-full">
          Create account
        </Button>
      </form>
    </AuthLayout>
  );
}
