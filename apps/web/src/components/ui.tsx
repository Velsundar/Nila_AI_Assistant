"use client";

import { forwardRef, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";

const variants: Record<Variant, string> = {
  primary:
    "bg-accent text-accent-ink hover:bg-accent-strong shadow-[0_0_24px_-6px_var(--color-accent)] disabled:shadow-none",
  secondary: "bg-surface-2 text-fg border border-line hover:border-line-strong hover:bg-surface-3",
  ghost: "bg-transparent text-muted hover:text-fg hover:bg-surface-2",
  danger: "bg-transparent text-danger border border-danger/40 hover:bg-danger/10",
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean; size?: "sm" | "md" }
>(function Button({ variant = "primary", loading, size = "md", className, children, disabled, type = "button", ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-control font-medium transition-colors select-none",
        "disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-8 px-3 text-sm" : "h-11 px-4 text-sm",
        variants[variant],
        className,
      )}
      {...rest}
    >
      {loading && <Spinner className="size-4" />}
      {children}
    </button>
  );
});

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn("animate-spin", className)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

const controlBase =
  "w-full rounded-control border bg-surface-2 px-3 text-sm text-fg placeholder:text-faint transition-colors " +
  "focus:outline-none focus-visible:outline-none focus:border-accent focus:ring-2 focus:ring-accent/30";

type FieldProps = { label: string; error?: string; hint?: ReactNode };

export const TextField = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & FieldProps>(
  function TextField({ label, error, hint, className, id, ...rest }, ref) {
    const autoId = useId();
    const inputId = id ?? autoId;
    const msgId = `${inputId}-msg`;
    return (
      <div className={cn("flex flex-col gap-1.5", className)}>
        <label htmlFor={inputId} className="text-xs font-medium tracking-wide text-muted">
          {label}
        </label>
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || hint ? msgId : undefined}
          className={cn(controlBase, "h-11", error ? "border-danger" : "border-line")}
          {...rest}
        />
        {error ? (
          <p id={msgId} className="text-xs text-danger" role="alert">
            {error}
          </p>
        ) : hint ? (
          <p id={msgId} className="text-xs text-faint">
            {hint}
          </p>
        ) : null}
      </div>
    );
  },
);

export const SelectField = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & FieldProps>(
  function SelectField({ label, error, hint, className, id, children, ...rest }, ref) {
    const autoId = useId();
    const selectId = id ?? autoId;
    const msgId = `${selectId}-msg`;
    return (
      <div className={cn("flex flex-col gap-1.5", className)}>
        <label htmlFor={selectId} className="text-xs font-medium tracking-wide text-muted">
          {label}
        </label>
        <div className="relative">
          <select
            ref={ref}
            id={selectId}
            aria-invalid={error ? true : undefined}
            aria-describedby={error || hint ? msgId : undefined}
            className={cn(controlBase, "h-11 appearance-none pr-9", error ? "border-danger" : "border-line")}
            {...rest}
          >
            {children}
          </select>
          <svg
            aria-hidden="true"
            viewBox="0 0 20 20"
            className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          >
            <path d="M5.5 7.5 10 12l4.5-4.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        {error ? (
          <p id={msgId} className="text-xs text-danger" role="alert">
            {error}
          </p>
        ) : hint ? (
          <p id={msgId} className="text-xs text-faint">
            {hint}
          </p>
        ) : null}
      </div>
    );
  },
);

export function Card({ title, action, children, className }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-card border border-line bg-surface/80 p-4 sm:p-5", className)}>
      {(title || action) && (
        <div className="mb-4 flex items-center justify-between gap-3">
          {title && <h2 className="text-sm font-semibold tracking-wide text-fg">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Notice({ tone = "info", children, className }: { tone?: "info" | "warn" | "danger"; children: ReactNode; className?: string }) {
  const tones = {
    info: "border-glow/30 bg-glow/10 text-fg",
    warn: "border-warn/30 bg-warn/10 text-fg",
    danger: "border-danger/40 bg-danger/10 text-fg",
  };
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cn("rounded-control border px-3 py-2.5 text-sm", tones[tone], className)}>
      {children}
    </div>
  );
}

export function FullScreenLoader({ label = "Loading" }: { label?: string }) {
  return (
    <div className="grid min-h-dvh place-items-center bg-void" role="status" aria-label={label}>
      <div className="relative size-16">
        <div className="absolute inset-0 animate-breathe rounded-full bg-accent/30 blur-xl" />
        <div className="absolute inset-3 rounded-full bg-gradient-to-br from-accent to-glow opacity-80" />
      </div>
    </div>
  );
}
